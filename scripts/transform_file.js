#!/usr/bin/env node
const fs = require('fs-extra');
const _ = require('lodash');
const path = require('path');
const chalk = require('chalk');

const wd = path.resolve(__dirname, '..');

const { fabric } = require(wd);

function readFile(file) {
    return fs.readFileSync(path.resolve(wd, file)).toString('utf-8');;
}

function getVariableNameOfKey(raw, key) {
    const regex = new RegExp(`(.+)=\\s*${key.replaceAll('.', '\\.')}`, 'm');
    const result = regex.exec(raw);
    return result && result[1].trim();
}

function getVariableNameOfNS(raw, namespace) {
    const regex = new RegExp(`(.+)=\\s*${namespace.replaceAll('.', '\\.')}\\.+$`, 'm');
    const result = regex.exec(raw);
    return result ? result[1].trim() : namespace;
}

function findObject(raw, charStart, charEnd, startFrom = 0) {
    const start = raw.indexOf(charStart, startFrom);
    let index = start;
    let counter = 0;
    while (index < raw.length) {
        if (raw[index] === charStart) {
            counter++;
        }
        else if (raw[index] === charEnd) {
            counter--;
            if (counter === 0) {
                break;
            }
        }
        index++;
    }
    return start > -1 ?
        {
            start,
            end: index,
            raw: raw.slice(start, index + charEnd.length)
        } :
        null;
}


function removeCommas(raw) {
    let index = 0;
    const pairs = [
        { opening: '{', closing: '}', test(key, index, input) { return input[index] === this[key] } },
        { opening: '[', closing: ']', test(key, index, input) { return input[index] === this[key] } },
        { opening: '(', closing: ')', test(key, index, input) { return input[index] === this[key] } },
        { opening: '/*', closing: '*/', test(key, index, input) { return input[index] === this[key][0] && input[index + 1] === this[key][1] } },
    ];
    const stack = [];
    const commas = [];
    while (index < raw.length) {
        if (pairs.some(t => t.test('opening', index, raw))) {
            stack.push(raw[index]);
        }
        else if (pairs.some(t => t.test('closing', index, raw))) {
            stack.pop();
        }
        else if (raw[index] === ',' && stack.length === 1) {
            commas.push(index);
        }
        index++;
    }
    commas.reverse().forEach(pos => {
        raw = raw.slice(0, pos) + raw.slice(pos + 1);
    })
    return raw;
}

function removeComments(raw) {
    const startChar = '/**', endChar = '*/';
    let start = raw.indexOf(), end;
    while (start > -1) {
        end = raw.indexOf(endChar, start);
        raw = raw.slice(0, start) + raw.slice(end + endChar.length + 1);
        start = raw.indexOf(startChar);
    }
    return raw;
}

/**
 * 
 * @param {RegExpExecArray | null} regex 
 * @returns 
 */
function findClassBase(raw, regex) {
    const result = regex.exec(raw);
    if (!result) throw new Error(chalk.red('FAILED TO PARSE'));
    const [match, classNSRaw, superClassRaw] = result;
    const namespace = classNSRaw.trim();
    const name = namespace.slice(namespace.lastIndexOf('.') + 1);
    const superClasses = superClassRaw?.trim().split(',').filter(raw => !raw.match(/\/\*+/) && raw).map(key => key.trim()) || [];
    const rawObject = findObject(raw, '{', '}', result.index);
    const NS = namespace.slice(0, namespace.lastIndexOf('.'));
    const klass = fabric.util.resolveNamespace(NS === 'fabric' ? null : NS)[name];
    return {
        name,
        namespace,
        superClasses,
        superClass: superClasses.length > 0 ? superClasses[superClasses.length - 1] : undefined,
        requiresSuperClassResolution: superClasses.length > 0,
        match: {
            index: result.index,
            value: match
        },
        ...rawObject,
        klass,
        prototype: klass.prototype
    };
}

function findClass(raw) {
    const keyWord = getVariableNameOfNS(raw, 'fabric.util.createClass');
    const regex = new RegExp(`(.+)=\\s*${keyWord.replaceAll('.', '\\.')}\\((\.*)\\{`, 'm');
    return findClassBase(raw, regex);
}

function findMixin(raw) {
    const keyWord = getVariableNameOfNS(raw, 'fabric.util.object.extend');
    const regex = new RegExp(`${keyWord.replaceAll('.', '\\.')}\\((.+)\\.prototype,\.*\\{`, 'm');
    return findClassBase(raw, regex);
}

function transformSuperCall(raw) {
    const regex = /this.callSuper\((.+)\)/g;
    const result = regex.exec(raw);
    if (!result) {
        if (raw.indexOf('callSuper') > -1) throw new Error(chalk.red(`failed to replace 'callSuper'`));
        return raw;
    }
    const [rawMethodName, ...args] = result[1].split(',');
    const methodName = rawMethodName.replace(/'|"/g, '');
    const firstArgIndex = result[1].indexOf(args[0]);
    const rest = firstArgIndex > -1 ? result[1].slice(firstArgIndex, result[1].length).trim() : '';
    const transformedCall = `super${methodName === 'initialize' ? '' : `.${methodName}`}(${rest})`;
    return raw.slice(0, result.index) + transformedCall + raw.slice(result.index + result[0].length);
}

function generateClass(rawClass, className, superClass) {
    return `export class ${className}${superClass ? ` extends ${superClass}` : ''} ${rawClass}`;
}

function generateMixin(rawClass, mixinName, baseClassNS) {
    const funcName = `${mixinName}Generator`;
    return `
export function ${funcName}(Klass) {
  return class ${mixinName||''} extends Klass ${rawClass}
}

${baseClassNS ? `${baseClassNS} = ${funcName}(${baseClassNS});`:''}
`;
}

function getMixinName(file) {
    const name = path.parse(file).name.replace('mixin', '').split('.').map(val=>_.upperFirst(_.camelCase(val))).join('');
    return name.replace('Itext','IText') + 'Mixin';
}

function transformFile(raw, { namespace, name } = {}) {
    if (raw.startsWith('(function')) {
        const wrapper = findObject(raw, '{', '}');
        raw = wrapper.raw.slice(1, wrapper.raw.length - 1);
    }

    const annoyingCheck = new RegExp(`if\\s*\\(\\s*(global.)?${namespace.replace(/\./g, '\\.')}\\s*\\)\\s*{`);
    const result = annoyingCheck.exec(raw);
    if (result) {
        const found = findObject(raw, '{', '}', result.index);
        raw = raw.slice(0, result.index) + raw.slice(found.end+1);
    }
    raw = `//@ts-nocheck\n${raw}`;
    //raw = `${raw}\n/** @todo TODO_JS_MIGRATION remove next line after refactoring build */\n${namespace} = ${name};\n`;
    return raw;
}

/**
 * 
 * @param {string} file 
 * @param {'class'|'mixin'} type 
 * @returns 
 */
function transformClass(type, raw, className) {
    if (!type) throw new Error(chalk.red(`INVALID_ARGUMENT type`));
    let {
        prototype,
        match,
        name,
        namespace,
        superClass,
        raw: rawClass,
        end,
        requiresSuperClassResolution,
        superClasses
    } = type === 'mixin' ? findMixin(raw) : findClass(raw);
    const getPropStart = (key) => {
        const searchPhrase = `${key}\\s*:\\s*`;
        const regex = new RegExp(searchPhrase);
        return { start: regex.exec(rawClass)?.index || -1, regex };
    }
    const staticCandidantes = [];
    Object.keys(prototype).forEach((key) => {
        const object = prototype[key];
        if (typeof object === 'function') {
            const searchPhrase = `^(\\s*)${key}\\s*:\\s*function\\s*\\(`;
            const regex = new RegExp(searchPhrase, 'm');
            const result = regex.exec(rawClass);
            if (!result) return;
            const whitespace = result[1];
            const start = result.index + whitespace.length;
            const func = findObject(rawClass, '{', '}', start);
            start && func.raw.indexOf('this') === -1 && staticCandidantes.push(key);
            rawClass = rawClass.replace(regex, `${whitespace}${key === 'initialize' ? 'constructor' : key}(`);
            if (regex.exec(rawClass)) {
                throw new Error(chalk.red(`dupliate method found ${name}#${key}`));
            }
            
        }
        else {
            const start = getPropStart(key);
            rawClass = rawClass.replace(start.regex, `${key} = `);
        }
    });
    let transformed = rawClass;
    do {
        rawClass = transformed;
        try {
            transformed = transformSuperCall(rawClass);
        } catch (error) {
            console.error(error);
        }
    } while (transformed !== rawClass);
    rawClass = removeCommas(rawClass);
    const classDirective = type === 'mixin' ?
        generateMixin(rawClass, className.indexOf(name)===-1?`${_.upperFirst(name)}${className}`:className || name, namespace) :
        generateClass(rawClass, className || name, superClass);
    raw = `${raw.slice(0, match.index)}${classDirective}${raw.slice(end + 1).replace(/\s*\)\s*;?/, '')}`;
    if (type === 'mixin') {
        //  in case of multiple mixins in one file
        try {
            return transformClass(type, raw, className);
        } catch (error) {
            
        }
    }
    raw = transformFile(raw, { namespace, name });
    return { name, raw, staticCandidantes, requiresSuperClassResolution, superClasses };
}

function convertFile(type, source, dest) {
    try {
        const {
            name,
            raw,
            staticCandidantes,
             requiresSuperClassResolution, 
            superClasses
        } = transformClass(type, readFile(source), type === 'mixin' && getMixinName(path.parse(source).name));
        dest = (typeof dest === 'function' ? dest(name) : dest) || source;
        fs.writeFileSync(dest, raw);
        console.log({
            state: 'success',
            source: path.relative(wd, source),
            destination: path.relative(wd, dest),
            class: name,
            requiresSuperClassResolution: requiresSuperClassResolution ? superClasses : false,
            staticCandidantes: staticCandidantes.length > 0? staticCandidantes: 'none'
        });
    } catch (e) {
        console.error(chalk.bold(chalk.yellow(`failed to convert ${path.relative(wd, source)}`)), e);
    }
}

const classDirs = ['shapes', 'brushes', 'filters'];
const mixinsDir = path.resolve(wd, './src/mixins');
const srcDir = path.resolve(wd, './src');
const fileExt = 'js';
const overwriteExisitingFiles = true;
classDirs.forEach(klsDir => {
    const dir = path.resolve(srcDir, klsDir);
    fs.readdirSync(dir).forEach(file => {
        convertFile('class', path.resolve(dir, file), overwriteExisitingFiles ? false : name => path.resolve(dir, `${name}.${fileExt}`));
    });
})

fs.readdirSync(mixinsDir).forEach(file => {
    convertFile('mixin', path.resolve(mixinsDir, file), overwriteExisitingFiles ? false : path.resolve(mixinsDir, `${getMixinName(file)}.${fileExt}`));
});
const additionalFile = fs.readdirSync(srcDir).filter(file => !fs.lstatSync(path.resolve(srcDir, file)).isDirectory());
additionalFile.forEach(file => {
    convertFile('class', path.resolve(srcDir, file), overwriteExisitingFiles ? false : name => path.resolve(srcDir, `${name}.${fileExt}`));
});