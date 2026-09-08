import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** Extend entry-point fixtures with real new TS modules, keeping their existing OS doubles. */
export function sourceLoader(entry, boundaries) {
  const require = createRequire(entry), cache = new Map();
  const known = new Map(Object.entries(boundaries).filter(([key]) => key.startsWith('.')).map(([key, value]) => [resolve(dirname(entry), `${key}.ts`), value]));
  function load(filename) {
    if (known.has(filename)) return known.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const source = readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href));
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(compiled, { module, exports: module.exports, __dirname: dirname(filename),
      require: key => get(key, filename), console, process, Buffer, Error, URL, AbortController, fetch: boundaries.fetch ?? (() => { throw new Error('Network disabled in source fixture'); }), Uint8Array, ArrayBuffer, setTimeout, clearTimeout, setInterval, clearInterval,
    }, { filename });
    return module.exports;
  }
  function get(key, importer = entry) {
    if (boundaries[key] && !key.startsWith('.')) return boundaries[key];
    if (!key.startsWith('.')) return require(key);
    const file = resolve(dirname(importer), key);
    return load(extname(file) ? file : `${file}.ts`);
  }
  return get;
}
