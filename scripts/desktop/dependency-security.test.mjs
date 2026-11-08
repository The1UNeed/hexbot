import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

// Resolve the exact dependencies Expo uses, rather than an unrelated hoisted copy.
const mobile = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const expo = createRequire(mobile.resolve('expo/package.json'));
const config = createRequire(expo.resolve('@expo/config'));
const cli = createRequire(expo.resolve('@expo/cli'));
const eas = createRequire(mobile.resolve('eas-cli/package.json'));
const legacyConfig = createRequire(createRequire(eas.resolve('@expo/prebuild-config')).resolve('@expo/config'));
const fixture = process.env.HEXBOT_DEPENDENCY_FIXTURES;
const copies = [
  {name:'Expo', glob:'13.0.6', minimatch:'10.2.6', require:cli},
  {name:'EAS', glob:'10.5.0', minimatch:'9.0.9', require:legacyConfig},
].map(copy => ({...copy,
  globPath: fixture ? copy.require.resolve(join(fixture, `glob@${copy.glob}`)) : copy.require.resolve('glob'),
}));
const merge = config(fixture ? join(fixture, 'deepmerge@4.3.1/dist/cjs.js') : 'deepmerge');
const buildPath = (path, format) => join(dirname(dirname(path)), format, basename(path));

test('deepmerge never adopts prototypes from either input or nested null placeholders', () => {
  const poisoned = JSON.parse('{"__proto__":{"injected":true},"safe":1}');
  for (const target of [Object.create(null), poisoned, null, 1]) {
    for (const source of [poisoned, {safe:2}]) {
      const merged = merge(target, source);
      assert.equal(Object.getPrototypeOf(merged), Object.prototype);
      assert.equal(merged.injected, undefined);
      assert.equal(Object.hasOwn(merged, '__proto__'), false);
    }
  }
  const nested = merge({plugin:null}, {plugin:poisoned});
  assert.equal(nested.plugin.injected, undefined);
  assert.deepEqual(merge({a:{x:1}, list:[1]}, {a:{y:2}, list:[2]}), {a:{x:1,y:2}, list:[1,2]});
});

for (const copy of copies) for (const format of ['commonjs', 'esm']) {
  test(`${copy.name} minimatch ${format} bounds expansion without changing ordinary matches`, async () => {
    const minimatchPath = fixture ? join(fixture, `minimatch@${copy.minimatch}/dist/commonjs/index.js`)
      : createRequire(copy.globPath).resolve('minimatch');
    const path = buildPath(minimatchPath, format);
    const {Minimatch} = await import(pathToFileURL(path));
    const pattern = Array(8).fill('**/../a/b').join('/');
    assert.equal(new Minimatch(pattern, {optimizationLevel:2, braceExpandMax:8}).set.length, 8);
    const small = new Minimatch('**/../a/b/**/../c/d', {optimizationLevel:2});
    assert.equal(small.set.length, 4);
    assert.equal(small.match('../a/b/../c/d'), true);
    assert.equal(small.match('x/a/b/y/c/d'), true);
    const large = new Minimatch('{x,*}/{0..999}', {optimizationLevel:2});
    assert.equal(large.set.length, 2000);
    assert.equal(large.match('x/5'), true);
    assert.equal(large.match('y/999'), true);
    assert.equal(large.match('.y/5'), false);
  });
}

for (const copy of copies) for (const format of ['commonjs', 'esm']) for (const stream of [false, true]) {
  test(`${copy.name} glob ${format} ${stream ? 'stream' : 'promise'} stops reads after cancellation`, {timeout:5000}, async t => {
    const {glob, globStream} = await import(pathToFileURL(buildPath(copy.globPath, format)));
    const root = fs.mkdtempSync(join(tmpdir(), 'hexbot-glob-abort-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    for (let a=0; a<4; a++) for (let b=0; b<4; b++) {
      const folder = join(root, String(a), String(b));
      fs.mkdirSync(folder, {recursive:true});
      fs.writeFileSync(join(folder, 'entry.ts'), '');
    }
    const controller = new AbortController();
    const drained = Promise.withResolvers();
    let active = 0, reads = 0, afterAbort = 0;
    const options = {cwd:root, signal:controller.signal, fs:{...fs,
      readdir(path, options, callback) {
        reads++;
        if (controller.signal.aborted) afterAbort++;
        active++;
        fs.readdir(path, options, (error, entries) => {
          if (!controller.signal.aborted) controller.abort(new Error('fixture abort'));
          callback(error, entries);
          if (--active === 0) drained.resolve();
        });
      }
    }};
    const walking = stream
      ? new Promise((resolve, reject) => globStream('**/*.ts', options).on('error', reject).on('end', resolve).resume())
      : glob('**/*.ts', options);
    await assert.rejects(walking, /fixture abort/);
    await drained.promise;
    assert.equal(reads, 1);
    assert.equal(afterAbort, 0);
    assert.equal((await glob('**/*.ts', {cwd:root})).length, 16);
  });
}

for (const format of ['cjs','esm']) {
  test(`ts-deepmerge ${format} retains built-in object methods`, async () => {
    const path = fixture ? join(fixture, `ts-deepmerge@6.2.0/${format}/index.js`)
      : buildPath(eas.resolve('ts-deepmerge'), format);
    const imported = await import(pathToFileURL(path));
    const merge = format === 'cjs' ? imported.default.default : imported.default;
    const malicious = JSON.parse('{"toString":"bad","valueOf":null,"hasOwnProperty":false,"isPrototypeOf":0,"propertyIsEnumerable":0,"toLocaleString":0}');
    const result = merge({title:'Hello',nested:{}}, {...malicious,nested:malicious});
    assert.equal(String(result), '[object Object]');
    assert.equal(String(result.nested), '[object Object]');
    for (const key of Object.keys(malicious)) assert.equal(typeof result[key], 'function');
    assert.deepEqual(merge({list:[1],a:{x:1}}, {list:[1,2],a:{y:2}}), {list:[1,2],a:{x:1,y:2}});
    assert.deepEqual(merge.withOptions({mergeArrays:false}, {list:[1]}, {list:[2]}), {list:[2]});
  });
}

test('Joi multiple email validation handles long whitespace within a bounded child', () => {
  const joi = fixture ? join(fixture, 'joi/lib/index.js') : eas.resolve('joi');
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Joi = require(process.argv[1]);
    const schema = Joi.string().email({multiple:true});
    assert.ok(schema.validate(' '.repeat(250000)).error);
    assert.equal(schema.validate('a@example.com, b@example.com').error, undefined);
    assert.equal(Joi.string().email({multiple:true,separator:';'}).validate('a@example.com; b@example.com').error, undefined);
  `, joi], {timeout:5000, stdio:'pipe'});
});
