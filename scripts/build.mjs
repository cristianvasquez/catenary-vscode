import { build } from 'esbuild';
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('src/catenary/rdf/notations', 'dist/notations', { recursive: true });
// The extension host bundle (CommonJS: VS Code loads it with require) and the webview bundle (the GLSP client). Their classes use
// inversify property injection, which needs the legacy decorators and class fields (a field declaration must not reset an injected
// property). The notations are read from dist/notations (import.meta.url is the URL of the bundle file), the Oxigraph WebAssembly from dist.
const decorators = { tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } };
const [host, webview] = await Promise.all([
    build({ ...decorators, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, platform: 'node', format: 'cjs',
        target: 'node22', external: ['vscode'], metafile: true, logLevel: 'warning', minify: true, keepNames: true,
        define: { 'import.meta.url': '__catenaryImportMetaUrl' },
        banner: { js: "var __catenaryImportMetaUrl = require('url').pathToFileURL(__filename).href;" } }),
    build({ ...decorators, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife',
        target: 'es2022', loader: { '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' }, minify: true, keepNames: true, metafile: true, logLevel: 'warning' })
]);
// package.json has "type": "module": the CommonJS bundle needs its own package scope.
await writeFile('dist/package.json', JSON.stringify({ type: 'commonjs' }) + '\n');
await copyFile('node_modules/oxigraph/node_bg.wasm', 'dist/node_bg.wasm');
// The tree-sitter text patch (src/edit/text-patch.ts) loads its grammar and runtime next to the bundle (__dirname).
await copyFile('grammars/turtle.wasm', 'dist/turtle.wasm');
await copyFile('node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm');
await writeFile('dist/extension-metafile.json', JSON.stringify(host.metafile, null, 2) + '\n');
await writeFile('dist/webview-metafile.json', JSON.stringify(webview.metafile, null, 2) + '\n');
const own = metafile => Object.keys(metafile.inputs).filter(f => f.startsWith('src/'));
console.log(`extension bundle: ${own(host.metafile).length} source files; webview bundle: ${own(webview.metafile).length} source files`);
