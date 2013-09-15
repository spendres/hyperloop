var fs = require('fs'),
	path = require('path'),
	ejs = require('ejs'),
	semver = require('semver'),
	wrench = require('wrench'),
	_ = require('underscore'),
	log = require('../../log'),
	header_template = fs.readFileSync(path.join(__dirname,'templates','header.ejs')).toString(),
	impl_template = fs.readFileSync(path.join(__dirname,'templates','implementation.ejs')).toString(),
	class_header_template = fs.readFileSync(path.join(__dirname,'templates','class_header.ejs')).toString(),
	class_impl_template = fs.readFileSync(path.join(__dirname,'templates','class_implementation.ejs')).toString(),
	global_header_template = fs.readFileSync(path.join(__dirname,'templates','globals_header.ejs')).toString(),
	global_impl_template = fs.readFileSync(path.join(__dirname,'templates','globals_implementation.ejs')).toString(),
    template = fs.readFileSync(path.join(__dirname,'templates','template.ejs')).toString(),
	debug = false,
	symbols_by_framework = {};


//TODO: wrap this into a user-definable config

const AUTOIMPORTS = {
	'UIGestureRecognizer': [
		'UIKit/UIGestureRecognizerSubclass.h'
	]
};

const GLOBAL_AUTOIMPORTS = {
	'SystemConfiguration': [
		'SystemConfiguration/CaptiveNetwork.h'
	]
};

const BLACKLIST_FRAMEWORKS = [
	'JavaScriptCore',
	'CoreFoundation', // ignore since we have equivalents with toll-free bridging
	'GLKit', // do we want this?
	'CoreMIDI',
	'CoreMedia',
	'CoreText',
	'GSS',
	'OpenAL',
	'_OpenGLES',
	'Accelerate',
	'EventKit',
	'EventKitUI'
];

// special types that we need to deal with

const EXCLUDES = {
	'NSDictionary': {
		'methods': [
			'getObjects:andKeys:' //TODO
		]
	},
	'NSOrderedSet': {
		'methods': [
			'getObjects:range:' //TODO
		]
	},
	'NSArray': {
		'methods': [
			'getObjects:' //TODO
		]
	},
	'NSNetService': {
		'methods': [
			'getInputStream:outputStream:'
		]
	},
	'CAMediaTimingFunction': {
		'methods': [
			'getControlPointAtIndex:values:'
		]
	},
	'Foundation': [
		'NSLogv'
	]
}

const TRANSLATED_TYPES = {
	'CFString': 'CFStringRef'
};

function unwrapSpecialObjCTypes(type) {
	var t = type.replace(/__unsafe_unretained/g,'').replace(/__strong/g,'').replace('volatile','').replace('*const','').trim();
	if (t in TRANSLATED_TYPES) {
		return TRANSLATED_TYPES[t];		
	}
	return t;
}

function generateReturnType(type,subtype,varname,className) {
	if (type==='void') return 'void';
	if (type==='id' && subtype==='instancetype') {
		return className.replace(/Class$/,'') + '* ' + varname;
	}
	var i = type.indexOf('^');
	if (i<0) {
		if (/^(Class|SEL)/.test(type) && /\*$/.test(type)) {
			type = type.replace('*','').trim();
		}
		i = type.indexOf('(*)');
		if (i<0) {
			return unwrapSpecialObjCTypes(type)+' '+varname;
		}
		return unwrapSpecialObjCTypes(type.substring(0,i) + '(*' + varname + ')' + type.substring(i+3));
	}
	return unwrapSpecialObjCTypes(type.substring(0,i) + '^' + varname + type.substring(i+1));
}

function copyProperties(instance,properties_obj,properties_to_exclude,methods_to_exclude,readonly_properties,readwrite_properties,imports,version,entry) {            
    properties_obj && Object.keys(properties_obj).forEach(function(p) {
        var property = properties_obj[p],
            attributes = property.attributes,
            readonly = attributes && attributes.indexOf('readonly')!=-1,
            availability = property.availability || {platform:'ios'};
        if (availability.message==='Unavailable' || availability.platform!=='ios') {
            return;
        }
        if (property.unavailable) {
            return;
        }
        if (satisfies(availability.deprecated,version)) {
            debug && log.debug('skipping deprecated property',p,'in',entry.name);
            return;
        }
        if (properties_to_exclude && properties_to_exclude.indexOf(p)!==-1) {
            debug && log.debug('skipping excluded property',p,'in',entry.name);
            methods_to_exclude.push('set'+p.charAt(0).toUpperCase()+p.substring(1)+':');
            methods_to_exclude.push(p);
            return;
        }
        // don't overwrite if base class already has it
        if (p in readonly_properties || p in readwrite_properties) return;
        readonly ? readonly_properties[p]=property : readwrite_properties[p]=property;
        if (property.framework && imports.indexOf(property.framework)===-1) {
            imports.push(property.framework);
        }
    }); 
//	console.error(readonly_properties);
//	console.error(readwrite_properties);
//	process.exit(1)
}

function copyMethod(instance,methods_obj,methods,readonly_properties,readwrite_properties,methods_to_exclude,imports,version,entry,m,method) {
	var availability = method.availability || {platform:'ios'};
    if (availability.message==='Unavailable' || availability.platform!=='ios') {
        return;
    }
    if (method.unavailable) {
        return;
    }
    if (satisfies(availability.deprecated,version)) {
        debug && log.debug('skipping deprecated method',m,'in',entry.name);
        return;
    }
    if (methods_to_exclude && methods_to_exclude.indexOf(method.selector)!==-1) {
        debug && log.debug('skipping excluded method',m,'in',entry.name);
        return;
    }
    if (method.instance===instance) {
    	if (m in methods) {
    		methods[m].push(method);
    	}
    	else {
	        methods[m] = [method];
    	}
        if (method.framework && imports.indexOf(method.framework)===-1) {
            imports.push(method.framework);
        }
    }
}
function copyMethods(instance,methods_obj,methods,readonly_properties,readwrite_properties,methods_to_exclude,imports,version,entry) {
    methods_obj && Object.keys(methods_obj).forEach(function(m){
	    if ((m in readonly_properties) || (m in readwrite_properties)) {
	        return;
	    }
	    var method = methods_obj[m];
	    if (method.constructor.name === Array.prototype.constructor.name) {
	    	method.forEach(function(mo){
	    		copyMethod(instance,methods_obj,methods,readonly_properties,readwrite_properties,methods_to_exclude,imports,version,entry,m,mo);
	    	});
	    }
	    else {
			copyMethod(instance,methods_obj,methods,readonly_properties,readwrite_properties,methods_to_exclude,imports,version,entry,m,method);	    	
	    }
    }); 
}

function hasMethodPrototype(metadata,entry,name) {
	while(entry) {
		if (entry.methods && name in entry.methods) {
			return true;
		}
		entry = entry.superClass;
	}
	return false;
}

function makeException(indent,message) {
	var body = [];
	body.push('JSStringRef string = JSStringCreateWithUTF8CString("'+message+'");');
	body.push(indent+'JSValueRef message = JSValueMakeString(ctx, string);');
	body.push(indent+'JSStringRelease(string);');
	body.push(indent+'*exception = JSObjectMakeError(ctx, 1, &message, 0);');
	body.push(indent+'return JSValueMakeUndefined(ctx);');
	return body.join('\n');
}

function generateInvocation(metadata,externs,makers,entry,method,instance,name,indent,skipLengthCheck) {
	var returnType = generateReturnType(method.returnType, method.returnSubtype, 'value', entry.name),
		body = [],
		noReturnValue = returnType==='void';

	// console.log(entry.name,method.name,returnType,noReturnValue,method.returnType);

	if (method.args.length === 0) {
		if (!noReturnValue) {
			body.push(returnType+' = ['+instance + ' ' + name + '];');
			body.push(indent+'UNUSED(value);');
		}
		else {
			body.push('['+instance + ' ' + name + '];');
		}
		body.push(indent+generateJSCType(metadata,externs,makers,entry.name,method.returnType,method.returnSubtype,'value','result',indent));
		body.push(indent+'return result;');
	}
	else {
		if (method.formatter) {
			//TODO:
			if (instance+'Class' !== entry.name) {
				body.push('UNUSED('+instance+');');
			}
			body.push((body.length?indent:'')+'return JSValueMakeUndefined(ctx);');
		}
		else {
			if (!skipLengthCheck) {
				body.push('if (argumentCount!='+method.args.length+')');
				body.push(indent+'{');
				body.push(indent+makeException(indent,'wrong number of arguments passed, expected '+method.args.length));
				body.push(indent+'}');
			}
			else {
				body.push('');
			}
			var args = [], argnames = {}, cleanup = [];
			for (var c=0;c<method.args.length;c++) {
				var name = method.args[c].name || 'arg'+c,
					type = method.args[c].type;
				// sometimes the argument names are the same so we need to make sure we don't have duplicates
				if (name in argnames) {
					name = 'arg'+c;
				}
				argnames[name]=1;
				body.push(indent+'JSValueRef '+name+'ValueRef = arguments['+c+'];');
				body.push(indent+'UNUSED('+name+'ValueRef);');
				var gen = generateObjCType(metadata,type,method.args[c].subtype,entry.name,name+'ValueRef',name+'$',indent);
				body.push(indent+gen.code);
				var cast = '('+ (gen.cast || type) + ')';
				args.push(cast + (gen.use_pointer ? '&':'')+name+'$');
				if (gen.cleanup) {
					cleanup.push(gen.cleanup);
				}
			}
			var line = [], c = 0;
			method.selector.split(':').forEach(function(n){
				if (c++ < args.length)
					line.push((n||'')+':'+args[c-1]);
			});
			if (method.requiresSentinel) {
				line.push(',nil');
			}
			if (!noReturnValue) {
				body.push(indent + returnType+' = ['+instance + ' ' + line.join(' ') + '];');
				body.push(indent+'UNUSED(value);');
			}
			else {
				body.push(indent +'['+instance + ' ' + line.join(' ') + '];');
			}
			body.push(indent + generateJSCType(metadata,externs,makers,entry.name,method.returnType,method.returnSubtype,'value','result',indent));
			cleanup.length && body.push(cleanup.join('\n'));
			body.push(indent + 'return result;');
		}
	}
	return body.join('\n');
}

function generateDynamicArg (metadata, type, subtype, className, varname, resultname, indent, prepend, index, length) {
	var args = [].concat(prepend||[]),
		body = [],
		cleanup = [];
	type = unwrapSpecialObjCTypes(type);
	for (var i=index;i<index+length+1;i++) {
		body.push((body.length ? indent : '') + 'JSValueRef '+varname+'$'+i+' = '+varname+'['+i+'];');
		body.push(indent + 'UNUSED(' + varname+'$'+i+');');

		var gen = generateObjCType(metadata,type,subtype,className,varname+'$'+i,resultname+'$'+i,indent);
		var cast = gen.cast ? '('+ (gen.cast) + ')' : '';
		args.push(cast + (gen.use_pointer ? '&':'')+resultname+'$'+i);
		gen.cleanup && cleanup.push(gen.cleanup);
		body.push(indent + gen.code);
	}
	return {
		code: body.join('\n'),
		args: args,
		cleanup: cleanup,
	};
}

var structOrEnumTypeRegex = /^(struct|enum) (\w+)/,
	constTypeRegex = /^const (.*)/,
	protocolRegex = /(\w+)<(.*)>/,
	primitiveTypeRegex = /^(un)?(signed)?\s*(short|float|double|long|bool|int|char|unichar|_Bool)/i,
	voidpointerRegex = /^(const)?\s*void/,
	subarrayRegex = /(\w+)\s*\[(\d+)\]/;

function wrapResultObject(obj) {
	if (obj) {
		if (structOrEnumTypeRegex.test(obj.type)) {
			var m = structOrEnumTypeRegex.exec(obj.type);
			obj.metatype = m[1];
		}
		if (primitiveTypeRegex.test(obj.type)) {
			obj.metatype = 'primitive';
		}
		if (voidpointerRegex.test(obj.type)){
			obj.metatype = 'void_pointer';
		}
		obj.is_pointer = obj.is_pointer || subarrayRegex.test(obj.type);
	}
	return obj;
}

function resolveType(metadata,type,realtype,subtype) {
	// console.log(type);
	var obj = metadata.classes[type];
	if (!obj) {
		if (protocolRegex.test(type)) {
			var m = protocolRegex.exec(type);
			return {
				metatype: 'protocol',
				protocol: m[2],
				interface: m[1]
			};
		}
		if (constTypeRegex.test(type)) {
			type = constTypeRegex.exec(type)[1];
			if (obj = metadata.classes[type]) {
				return obj; 
			}
		}
		if (structOrEnumTypeRegex.test(type)) {
			obj = metadata.types[type];
			if (obj) return wrapResultObject(obj);
			type = structOrEnumTypeRegex.exec(type)[2];
		}
		if (subarrayRegex.test(type)) {
			var m = subarrayRegex.exec(type),
				newtype = m[1],
				size = m[2];
			obj = metadata.types[newtype];
			if (obj) {
				obj.is_pointer = true;
				obj.size = size;
				return obj;
			}
		}
		obj = metadata.types[type];
		if (!obj) {
			if (type.charAt(0)==='_') {
				obj = metadata.types[type.substring(1)];
				if (obj) return wrapResultObject(obj);
			}
			if (primitiveTypeRegex.test(type)) {
				return {
					metatype:'primitive',
					type: realtype,
					subtype: subtype
				};
			}
			obj = metadata.types[subtype];
			if (!obj) {
				if (voidpointerRegex.test(type)) {
					return {
						metatype: 'void_pointer',
						type:realtype,
						subtype:subtype
					};
				}
				console.log("Couldn't resolve type: "+realtype||type);
				process.exit(1);
			}
		}
	}
	return wrapResultObject(obj) || realtype;
}

function structFromObject(metadata, struct, value, varname, indent) {
	var body = [],
		fields = _.map(struct.fields||[],function(){return '0'});

	if (fields.length) {
		body.push(struct.type+' '+varname+' = { ' + fields.join(', ') + ' };');
	    body.push(indent+'JSObjectRef '+varname+'vo = JSValueToObject(ctx,'+value+',exception);');
	    body.push(indent+'JSPropertyNameArrayRef '+varname+'props = JSObjectCopyPropertyNames(ctx,'+varname+'vo);');
	    body.push(indent+'size_t '+varname+'count = JSPropertyNameArrayGetCount('+varname+'props);');
	    body.push(indent+'for (size_t '+varname+'i=0; '+varname+'i<'+varname+'count; '+varname+'i++)');
	    body.push(indent+'{');
	    body.push(indent+indent+'JSStringRef '+varname+'propName = JSPropertyNameArrayGetNameAtIndex('+varname+'props,'+varname+'i);');
	    body.push(indent+indent+'JSValueRef '+varname+'propValue = JSObjectGetProperty(ctx,'+varname+'vo,'+varname+'propName,0);');
	    body.push(indent+indent+'JSObjectRef '+varname+'prop = JSValueToObject(ctx,'+varname+'propValue,0);');
	    body.push(indent+indent+'UNUSED('+varname+'prop);');
	    var count = 0;
		struct.fields.forEach(function(field){
			var if_or_elseif = (count++ === 0) ? 'if' : 'else if';
		    body.push(indent+indent+if_or_elseif+' (JSStringIsEqualToUTF8CString('+varname+'propName,"'+field.name+'"))');
		    body.push(indent+indent+'{');
		    if (primitiveTypeRegex.test(field.type) || primitiveTypeRegex.test(field.subtype)) {
		    	if (subarrayRegex.test(field.type)) {
		    		var m = subarrayRegex.exec(field.type),
		    			arrayType = m[1],
		    			arrayLength = m[2];
		    		//this is an array of primitives
		    		body.push(indent+indent+indent+'// array of pointers, copy them in to the struct');
		    		body.push(indent+indent+indent+'JSPropertyNameArrayRef '+varname+'$'+field.name+'$props = JSObjectCopyPropertyNames(ctx,'+varname+'prop);');
				    body.push(indent+indent+indent+'size_t '+varname+'$'+field.name+'$count = JSPropertyNameArrayGetCount('+varname+'$'+field.name+'$props);');
				    body.push(indent+indent+indent+'for (size_t '+varname+'$i=0;'+varname+'$i<'+varname+'$'+field.name+'$count && '+varname+'$i < '+arrayLength+';'+varname+'$i++)');
				    body.push(indent+indent+indent+'{');
	    			body.push(indent+indent+indent+indent+'JSStringRef '+varname+'$pn = JSPropertyNameArrayGetNameAtIndex('+varname+'$'+field.name+'$props,'+varname+'$i);');
	    			body.push(indent+indent+indent+indent+'JSValueRef '+varname+'$pv = JSObjectGetProperty(ctx,'+varname+'prop,'+varname+'$pn,0);');
				    body.push(indent+indent+indent+indent+varname+'.'+field.name+'['+varname+'$i] = ('+arrayType+')JSValueToNumber(ctx,'+varname+'$pv,0);');
				    body.push(indent+indent+indent+'}');
		    		body.push(indent+indent+indent+'JSPropertyNameArrayRelease('+varname+'$'+field.name+'$props);');
		    	}
		    	else {
				    body.push(indent+indent+indent+varname+'.'+field.name+' = JSValueToNumber(ctx,'+varname+'propValue,0);');
		    	}
		    }
		    else {
		    	//NOTE: we only support one-level of structs within structs
		    	var fieldClassType = getClassType(metadata,field.type,field.subtype);
		    	if (fieldClassType.metatype==='struct' || fieldClassType.fields) {
		    		var r = structFromObject(metadata,fieldClassType,varname+'prop',varname+'$'+count,indent+indent+indent);
		    		body.push(indent+indent+indent+r);
			    	body.push(indent+indent+indent+varname+'.'+field.name+' = '+varname+'$'+count+';');
		    	}
			    else {
			    	console.error('Unsupported struct subtype: ',fieldClassType);
			    	process.exit(1);
			    }
		    }
		    body.push(indent+indent+'}');
		});    
	    body.push(indent+'}');
		body.push(indent+'JSPropertyNameArrayRelease('+varname+'props);');
	}
	else {
		body.push(struct.type+(struct.is_pointer?'*':'')+' '+varname+';');
	}

	return body.join('\n');
}

function getClassType(metadata,type,subtype,className,resultname) {
	type = unwrapSpecialObjCTypes(type);
	var t = type.replace(/\*/g,'').trim(),
		i = type.indexOf('^'),
		r = type.indexOf('(*)'),
		is_callback = r>0,
		is_block = i>0,
		is_pointer = type.indexOf(' *')>0,
		is_pointer_to_pointer = type.indexOf(' **')>0;

	if (is_callback) {
		return {
			metatype: 'callback',
			type: type,
			subtype: subtype,
			is_pointer: is_pointer,
			is_pointer_to_pointer: is_pointer_to_pointer,
			code: type.substring(0,r) + '(*' + resultname + ')' + type.substring(r+3) + ' = NULL;',
			use_pointer: false
		};
	}
	else if (is_block) {
		var start = type.substring(0,i),
			end = type.substring(i+1);
		return {
			metatype: 'block',
			type: type,
			subtype: subtype,
			is_pointer: is_pointer,
			is_pointer_to_pointer: is_pointer_to_pointer,
			code: start + '^' + resultname + end + ' = NULL;',
			use_pointer: false
		};
	}
	
	if (t==='id' && subtype==='instancetype') {
		t = className.replace(/Class$/,'');
	}

	var obj = resolveType(metadata,t,type,subtype);
	obj.is_pointer = is_pointer;
	obj.is_pointer_to_pointer = is_pointer_to_pointer;
	obj.is_const = t.indexOf('const ')!==-1;
	obj.simple_type = t.replace('struct ',' ').replace('enum ',' ').replace(/(const)?(un)?(signed)? /g,' ').trim();
	obj.metatype = t.indexOf('struct ')!==-1 || subtype.indexOf('struct ')!==-1 ? 'struct' : obj.metatype;
	return obj;
}

function generateObjCType(metadata,type,subtype,className,varname,resultname,indent) {
	
	var typeObject = getClassType(metadata,type,subtype,className,resultname);

	switch (typeObject.metatype) {
		case 'callback':
		case 'block': {
//	console.error('gen varname=',varname,'resultname=',resultname)
			return typeObject;
		}
		case 'protocol':
		case 'interface': {
			var body = [],
				thetype = typeObject.metatype==='protocol' &&
						  type.indexOf('Class')!==-1 ? typeObject.simple_type : type;
			body.push('JSObjectRef ' + resultname + 'Obj = JSValueToObject(ctx,'+varname+',0);');
			body.push(indent + thetype + ' ' +resultname + ' = ('+thetype+') JSObjectGetPrivate('+resultname+'Obj);');
			return {
				code: body.join('\n'),
				use_pointer: false,
				cast: thetype
			};
		}
		case 'primitive': {
			if (typeObject.is_pointer) {
				if (typeObject.simple_type==='char') {
					var body = [],
						cleanup = [];
					//TODO: buf
					body.push('JSStringRef '+resultname+'StringRef = JSValueToStringCopy(ctx,'+varname+',0);');
					body.push(indent+'size_t '+resultname+'size = JSStringGetMaximumUTF8CStringSize('+resultname+'StringRef);');
					body.push(indent+'char *'+resultname+' = malloc(sizeof(char)*'+resultname+'size);');
					body.push(indent+'size_t '+resultname+'len = JSStringGetUTF8CString('+resultname+'StringRef,(char*)'+resultname+','+resultname+'size);');
					body.push(indent+resultname+'['+resultname+"len]='\\0';");
					cleanup.push(indent+'JSStringRelease('+resultname+'StringRef);');
					cleanup.push(indent+'free('+resultname+');');
					return {
						code: body.join('\n'),
						cleanup: cleanup.join('\n'),
						use_pointer: false
					};
				}
				return {
					code: typeObject.simple_type+' '+(typeObject.is_pointer_to_pointer?'*':'')+resultname+' = 0;',
					use_pointer: true
				};
			}
			return {
				code: type+' '+resultname+' = ('+type+')JSValueToNumber(ctx,'+varname+',0);',
				use_pointer: false
			};
		}
		case 'enum': {
			if (typeObject.is_pointer) {
				return {
					code: typeObject.simple_type+' '+resultname+' = 0;',
					use_pointer: true
				};
			}
			return {
				code: type+' '+resultname+' = ('+type+')JSValueToNumber(ctx,'+varname+',0);',
				use_pointer: false
			};
		}
		case 'struct': {
			if (typeObject.fields && !typeObject.is_pointer) {
				var so = structFromObject(metadata,typeObject,varname,resultname,indent);
				return {
					code: so,
					use_pointer: false
				};
			}
			if (type.indexOf('struct')===-1 || typeObject.is_pointer) {
				return {
					code: type+' '+resultname+' = 0;',
					use_pointer: false
				};
			}
			return {
				code: type+' '+resultname+';',
				use_pointer: false
			};
		}
		case 'void_pointer': {
			return {
				code: type+' '+resultname+' = NULL;',
				use_pointer: false
			};
		}
		case 'typedef': {

			switch(typeObject.type) {
				case 'id': {
					var body = [];
					body.push('JSObjectRef ' + resultname + 'Obj = JSValueToObject(ctx,'+varname+',0);');
					body.push(indent+type+' ' + resultname + ' = nil;');
					body.push(indent+'if (JSValueIsObject(ctx,'+varname+'))');
					body.push(indent+'{');
					body.push(indent+indent+' ' + resultname + ' = ('+type+') JSObjectGetPrivate('+resultname+'Obj);');
					body.push(indent+'}');
					body.push(indent+'else');
					body.push(indent+'{');
					body.push(indent+makeException(indent,'expected object but received something else'));
					body.push(indent+'}');
					return {
						code: body.join('\n'),
						use_pointer: false
					};
				}
				case 'SEL *': {
					return {
						code: 'SEL '+resultname + ' = NULL;',
						use_pointer: false,
						cast: 'SEL'
					};
				}
				case 'Class *': {
					return {
						code: 'Class '+resultname + ' = NULL;',
						use_pointer: false,
						cast: 'Class'
					};
				}
				default: {
					if (/^(const)?\s*struct/.test(typeObject.type) || /^(const)?\s*struct/.test(typeObject.subtype)) {
						if (typeObject.fields && !typeObject.is_pointer) {
							var so = structFromObject(metadata,typeObject,varname,resultname,indent);
							return {
								code: so,
								use_pointer: false
							};
						}
						return {
							code: type+' '+resultname+' = 0;',
							use_pointer: false
						}
					}
					else if (/^(const)?\s*enum/.test(typeObject.type) || /^(const)?\s*enum/.test(typeObject.subtype)) {
						if (typeObject.is_pointer) {
							return {
								code: typeObject.type+' '+resultname+';',
								use_pointer: true
							};
						}
						else {
							return {
								code: type+' '+resultname+' = ('+type+')JSValueToNumber(ctx,'+varname+',0);',
								use_pointer: false
							};
						}
					}
					else if (/^union/.test(typeObject.type) || /^union/.test(typeObject.subtype)) {
						if (typeObject.is_pointer) {
							return {
								code: typeObject.type+' '+resultname+';',
								use_pointer: true
							};
						}
						else {
							return {
								code: type+' '+resultname+';',
								use_pointer: false
							};
						}
					}
					if (typeObject.is_pointer) {
						// attempt to recurse with the type
						return generateObjCType(metadata,typeObject.type,typeObject.subtype,className,varname,resultname,indent);
					}
					console.error("Unknown typedef type: "+typeObject.type);
					console.error(typeObject);
					process.exit(1);
				}
			}

			break;
		}
		default: {
			console.error("Unknown metatype: "+typeObject.metatype);
			console.error(typeObject);
			process.exit(1);
		}
	}
}

function generateJSCType(metadata,externs,makers,className,type,subtype,varname,resultname,indent) {
	
	var typeObject = getClassType(metadata,type,subtype,className,resultname),
		code = [];

	switch(typeObject.metatype) {
		case 'primitive': {
			if (typeObject.subtype==='BOOL' || typeObject.simple_type==='bool') {
				code.push('JSValueRef '+resultname+' = JSValueMakeBoolean(ctx,(bool)'+varname+');');
			}
			else if (typeObject.simple_type==='char' && typeObject.is_pointer && !typeObject.is_pointer_to_pointer) {
				code.push('NSString *string = [NSString stringWithFormat:@"%s",'+varname+'];');
				code.push(indent+'JSStringRef str = JSStringCreateWithUTF8CString([string UTF8String]);');
				code.push(indent+'JSValueRef '+resultname+' = JSValueMakeString(ctx,str);');
				code.push(indent+'JSStringRelease(str);');
			}
			else if (typeObject.is_pointer) {
				// array of pointers
				code.push('size_t len = sizeof('+varname+');');
				code.push(indent+'JSValueRef array[len];');
				code.push(indent+'for (size_t i=0;i<len;i++)');
				code.push(indent+'{');
				code.push(indent+indent+'array[i] = JSValueMakeNumber(ctx,(double)'+varname+'[i]);');
				code.push(indent+'}');
				code.push(indent+'JSObjectRef '+resultname+' = JSObjectMakeArray(ctx,len,array,0);');
			}
			else {
				code.push('JSValueRef '+resultname+' = JSValueMakeNumber(ctx,(double)'+varname+');');
			}
			break;
		}
		case 'enum': {
			code.push('JSValueRef '+resultname+' = JSValueMakeNumber(ctx,(double)'+varname+');');
			break;
		}
		case 'struct': {
			//console.error('STRUCT not handled for',typeObject);
			code.push('JSObjectRef '+resultname+' = JSObjectMake(ctx, 0, 0);');
			typeObject.fields && typeObject.fields.forEach(function(field) {
				code.push(indent+'JSStringRef prop'+field.name+' = JSStringCreateWithUTF8CString("'+field.name+'");')
				if (primitiveTypeRegex.test(field.type) || primitiveTypeRegex.test(field.subtype)) {
					code.push(indent+'JSObjectSetProperty(ctx,'+resultname+',prop'+field.name+',JSValueMakeNumber(ctx,(double)'+varname+'.'+field.name+'),kJSPropertyAttributeNone,0);');
		    	}
		    	else {
		    		//NOTE: we only support one-level of structs within structs
		    		var fieldClassType = getClassType(metadata,field.type,field.subtype,resultname);
		    		if (fieldClassType.metatype==='struct') {
						code.push(indent+'JSObjectRef '+resultname+'$'+field.name+' = JSObjectMake(ctx, 0, 0);');
		    			fieldClassType.fields.forEach(function(subfield){
							if (primitiveTypeRegex.test(subfield.type) || primitiveTypeRegex.test(subfield.subtype)) {
								code.push(indent+'JSStringRef prop'+field.name+'$'+subfield.name+' = JSStringCreateWithUTF8CString("'+subfield.name+'");')
								code.push(indent+'JSObjectSetProperty(ctx,'+resultname+'$'+field.name+',prop'+field.name+'$'+subfield.name+',JSValueMakeNumber(ctx,(double)'+varname+'.'+field.name+'.'+subfield.name+'),kJSPropertyAttributeNone,0);');
						    	code.push(indent+'JSStringRelease(prop'+field.name+'$'+subfield.name+');');
					    	}
					    	else {
					    		console.error('more than one child structure inside structure not yet supported',fieldClassType);
					    		process.exit(1);
		    				}
		    			});
						code.push(indent+'JSObjectSetProperty(ctx,'+resultname+',prop'+field.name+','+resultname+'$'+field.name+',kJSPropertyAttributeNone,0);');
		    		}
		    	}
		    	code.push(indent+'JSStringRelease(prop'+field.name+');');
			});
			break;
		}
		case 'block': {
			//console.error('BLOCK not handled for',typeObject);
			code.push('JSValueRef '+resultname+' = JSValueMakeUndefined(ctx);');
			break;
		}
		case 'callback': {
			//console.error('CALLBACK not handled for',typeObject);
			code.push('JSValueRef '+resultname+' = JSValueMakeUndefined(ctx);');
			break;
		}
		case 'protocol':
		{
			if (makers.indexOf('NSObject')===-1) {
				makers.push('NSObject');
			}
			code.push('JSValueRef '+resultname+' = MakeObjectForNSObject(ctx,(NSObject*)'+varname+');');
			break;
		}
		case 'interface': {
			if (typeObject.simple_type==='id') {
				var instanceClassName = className.replace(/Class$/,'');
				code.push('JSObjectRef '+resultname+' = NULL;');
				code.push(indent+'if (['+varname+' class]==['+instanceClassName+' class])');
				code.push(indent+'{');
				code.push(indent+indent+resultname+' = MakeObjectFor'+instanceClassName+'(ctx, ('+instanceClassName+'*)'+varname+');')
				code.push(indent+'}');
				code.push(indent+'else');
				code.push(indent+'{');
				code.push(indent+indent+resultname+' = MakeObjectForNSObject(ctx, (NSObject*)'+varname+');')
				code.push(indent+'}');
				if (makers.indexOf(instanceClassName)===-1) {
					makers.push(instanceClassName);
				}
				if (makers.indexOf('NSObject')===-1) {
					makers.push('NSObject');
				}
			}
			else {
				var t = typeObject.simple_type,  
					cls = metadata.classes[t];
				if (cls) {
					if (externs.indexOf(t)===-1) {
						externs.push(t);
					}
					if (makers.indexOf(t)===-1) {
						makers.push(t);
					}
					code.push('JSObjectRef '+resultname+' = MakeObjectFor'+t+'(ctx, '+varname+');')
				}
				else {
					console.error('not handled for',t);
					code.push('JSValueRef '+resultname+' = JSValueMakeUndefined(ctx);');
				}
			}
			break;
		}
		default: {
			code.push('JSValueRef '+resultname+' = JSValueMakeUndefined(ctx);');
			break;
		}
	}

	return code.join('\n');
}

function satisfies(check, version) {
	//console.log('satisfies,version=',version,'check=',check);
	if (!check || check==='0') return false;
	check = makeVersion(check);
	version = makeVersion(version);
	//return semver.satisfies(version, ">="+check);  
	return semver.gte(version,check);	
}

function makeVersion(version) {
	if (version.split('.').length===2) {
		version+='.0';
	}
	return version;
}

function preflightChecks(version,entry,name) {
	if (!entry.framework) {
		debug && log.debug('refusing to build',name,"because there is no framework specified");
		return false;
	}
	if (BLACKLIST_FRAMEWORKS.indexOf(entry.framework)!==-1) {
		debug && log.debug('refusing to build',name,"because "+entry.framework+" is on the blacklist");
		return false;
	}
	if (entry.unavailable) {
		debug && log.debug('refusing to build',name,entry.unavailable);
		return false;
	}

	var availability = entry.availability;
	if (availability && availability.platform!=='ios') {
		debug && log.debug("skipping deprecated: "+name);
		return false;
	}
	if (availability && availability.message==="Unavailable") {
		debug && log.debug("skipping non-ios: "+name);
		return false;
	}
	if (availability && availability.deprecated && availability.deprecated!="0") {
		availability.deprecated+=".0";
		if (semver.gte(version,availability.deprecated)) {
			debug && log.debug("skipping deprecated: "+name);
			return false;
		}
	}
	return true;
}

function processSymbols(version, metadata, framework, symbols, dir, srcs) {

	var filename = path.join(dir, framework, framework+'_globals'),
		dirname = path.dirname(filename);

	if (!fs.existsSync(dirname)) {
		wrench.mkdirSyncRecursive(dirname);
	}

	var externs = [], 
		makers = [],
		autoimports = GLOBAL_AUTOIMPORTS[framework] || [];


	var impl = ejs.render(global_impl_template,{
		_debug: debug,
		metadata: metadata,
		version: version,
		framework: framework,
		symbols: symbols,
		externs: externs,
		makers: makers,
		autoimports: autoimports,
		satisfies: satisfies,
		generateObjCType: generateObjCType,
		generateJSCType: generateJSCType,
		generateDynamicArg: generateDynamicArg,
		makeException: makeException
	});
	fs.writeFileSync(filename+'.m', impl);

	srcs.push(filename+'.m');

	var header = ejs.render(global_header_template,{
		_debug: debug,
		metadata: metadata,
		version: version,
		framework: framework,
		symbols: symbols,
		externs: externs,
		makers: makers,
		autoimports: autoimports,
		satisfies: satisfies,
		generateObjCType: generateObjCType,
		generateJSCType: generateJSCType,
		generateDynamicArg: generateDynamicArg,
		makeException: makeException
	});
	fs.writeFileSync(filename+'.h', header);
}

function processClass(version, metadata, name, entry, dir, generated, srcs) {

	if (generated.indexOf(name)!==-1 || !entry) {
		return;
	}

	generated.push(name);

	entry.name = name;
	version = makeVersion(version,name);

	if (!preflightChecks(version,entry,name)) {
		return;
	}

	var exclusions = EXCLUDES[name] || {};
	if (exclusions && typeof(exclusions)==='true') {
		debug && log.debug("skipping excluded (by exclusion rule) class: "+name);
		return;
	}
	var filename = path.join(dir, entry.framework, entry.name),
		dirname = path.dirname(filename),
		externs = [],
		includes = [],
		makers = [],
		imports = ['JavaScriptCore',entry.framework];

	if (entry.superClass) {
		makers.push(entry.superClass);
	}

	var autoimports = AUTOIMPORTS[name];
	if (autoimports && autoimports.length)
	{
		includes = includes.concat(autoimports);
	}

	if (!fs.existsSync(dirname)) {
		wrench.mkdirSyncRecursive(dirname);
	}

	log.debug('Generating',(entry.framework+'/'+entry.name).yellow);

	var impl = ejs.render(impl_template,{
		_debug: debug,
		entry: entry,
		metadata: metadata,
		generateJSCType: generateJSCType,
		generateReturnType: generateReturnType,
		generateInvocation: generateInvocation,
		externs: externs,
		imports: imports,
		makers: makers,
		version: version,
		satisfies: satisfies,
		exclusions:exclusions,
		autoincludes:includes,
		copyProperties: copyProperties,
		copyMethods: copyMethods,
		hasMethodPrototype: hasMethodPrototype,
		getClassType: getClassType,
		structFromObject: structFromObject,
		makeException: makeException
	});
	fs.writeFileSync(filename+'.m', impl);
	srcs.push(filename+'.m');

	var header = ejs.render(header_template,{
		_debug: debug,
		entry: entry,
		metadata: metadata,
		generateJSCType: generateJSCType,
		generateReturnType: generateReturnType,
		generateInvocation: generateInvocation,
		externs: externs,
		imports: imports,
		makers: makers,
		version: version,
		satisfies: satisfies,
		exclusions:exclusions,
		autoincludes:includes,
		copyProperties: copyProperties,
		copyMethods: copyMethods,
		hasMethodPrototype: hasMethodPrototype,
		getClassType: getClassType,
		structFromObject: structFromObject,
		makeException: makeException
	});
	fs.writeFileSync(filename+'.h', header);

	makers = makers.concat(externs);

	makers.forEach(function(m){
		if (/Class$/.test(m)) {
			m = m.replace(/Class$/,'');
		}
		var entry = metadata.classes[m] || metadata.protocols[m];
		processClass(version, metadata, m, entry, dir, generated, srcs);
	});

	// now generate class 
	externs = [];
	imports = ['JavaScriptCore',entry.framework];
	makers = [];
	entry.name+='Class';

	if (entry.superClass) {
		makers.push(entry.superClass);
	}

	impl = ejs.render(class_impl_template,{
		_debug: debug,
		entry: entry,
		metadata: metadata,
		generateJSCType: generateJSCType,
		generateReturnType: generateReturnType,
		generateInvocation: generateInvocation,
		externs: externs,
		imports: imports,
		makers: makers,
		version: version,
		satisfies: satisfies,
		exclusions:exclusions,
		autoincludes:includes,
		copyProperties: copyProperties,
		copyMethods: copyMethods,
		hasMethodPrototype: hasMethodPrototype,
		getClassType: getClassType,
		structFromObject: structFromObject,
		makeException: makeException
	});
	fs.writeFileSync(filename+'Class.m', impl);
	srcs.push(filename+'Class.m');

	header = ejs.render(class_header_template,{
		_debug: debug,
		entry: entry,
		metadata: metadata,
		generateJSCType: generateJSCType,
		generateReturnType: generateReturnType,
		generateInvocation: generateInvocation,
		externs: externs,
		imports: imports,
		makers: makers,
		version: version,
		satisfies: satisfies,
		exclusions:exclusions,
		autoincludes:includes,
		copyProperties: copyProperties,
		copyMethods: copyMethods,
		hasMethodPrototype: hasMethodPrototype,
		getClassType: getClassType,
		structFromObject: structFromObject,
		makeException: makeException
	});
	fs.writeFileSync(filename+'Class.h', header);

	// generate superclass
	entry.superClass && processClass(version, metadata, entry.superClass, metadata.classes[entry.superClass], dir, generated, srcs);

	makers = makers.concat(externs);

	makers.forEach(function(m){
		if (/Class$/.test(m)) {
			m = m.replace(/Class$/,'');
		}
		var entry = metadata.classes[m] || metadata.protocols[m];
		processClass(version, metadata, m, entry, dir, generated, srcs);
	});

}

function generate (config) {
    var metadata = config.metadata, 
        generation = config.generation, 
        interfaceName = config.interfaceName, 
        depends = config.depends, 
        generated = config.generated, 
        prefix = config.prefix, 
        srchash = config.srchash, 
        srcs = config.srcs, 
        srcdir = config.srcdir,
        minversion = config.minversion,
        entry = metadata.classes[interfaceName];

    debug = config.debug;

    processClass(minversion, metadata, interfaceName, entry, srcdir, generated, srcs);
}

function generateCode (gen, genopts, callback) {

	var generated = gen.generated,
		metadata = genopts.metadata,
        generated = genopts.generated, 
        srcdir = genopts.srcdir,
        minversion = genopts.minversion,
        srcs = genopts.srcs;


    // generate our classes
	Object.keys(gen.classes).forEach(function(n){ 
		if (generated.indexOf(n)===-1) {
			var entry = metadata.classes[n];
		    processClass(minversion, metadata, n, entry, srcdir, generated, srcs);
		}
	});

	Object.keys(gen.functions).forEach(function(n){
		var entry = metadata.symbols[n],
			f = gen.functions[n][0],
			sym = f.symbol,
			symbols = symbols_by_framework[sym.framework];

		if (!symbols) {
			symbols_by_framework[sym.framework] = symbols = {};
		}

		if (!(n in symbols)) {
			symbols[n] = entry;
		}

	});

    // load the jsengine template file dynamically
    var source = ejs.render(template, {
        gen:gen,
        symbols: symbols_by_framework,
        frameworks: Object.keys(symbols_by_framework)
    });

    callback(null,source);
}

function precompile(genopts, callback) {

	var metadata = genopts.metadata,
        srcdir = genopts.srcdir,
        srcs = genopts.srcs,
        minversion = genopts.minversion;

	Object.keys(symbols_by_framework).forEach(function(n){
		var dict = symbols_by_framework[n],
			symbols = [];
		Object.keys(dict).forEach(function(e){
			symbols.push(metadata.symbols[e]);
		});
		processSymbols(minversion, metadata, n, symbols, srcdir, srcs);
	});

    return callback();
}

exports.generate = generate;
exports.generateCode = generateCode;
exports.precompile = precompile;
exports.arc = false;
