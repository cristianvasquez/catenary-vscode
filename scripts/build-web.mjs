// Builds the browser page into dist-web/: a static site that runs Catenary, Monaco and turtle-lsp (engine.wasm) in the tab.
//   main.js, main.css      the page (src/web/main.ts): files, tabs, Monaco, the GLSP server, the workspace graph
//   canvas.js, canvas.css  one canvas iframe (src/web/canvas.ts): the GLSP client of src/webview
//   turtle-lsp/            the turtle-lsp browser engine and modules (scripts/fetch-turtle-lsp.mjs, pinned by SHA-256)
//   vendor/monaco/         the Monaco editor (npm monaco-editor, minified AMD build)
// The shared code runs unchanged: node:fs, node:url, node:path and node:crypto map to browser shims (src/web/shims) over an in-memory file system.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const out = 'dist-web';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/** Files of `dir` (recursive) as { relative path: text }, without `skip`. */
async function textFiles(dir, skip = () => false) {
    const result = {};
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath ?? entry.path, entry.name), rel = path.relative(dir, full).split(path.sep).join('/');
        if (!skip(rel)) result[rel] = await readFile(full, 'utf8');
    }
    return result;
}

const shim = name => path.resolve(`src/web/shims/${name}.ts`);
const ALIASES = {
    'fs': shim('fs'), 'node:fs': shim('fs'),
    'url': shim('url'), 'node:url': shim('url'),
    'crypto': shim('crypto'), 'node:crypto': shim('crypto'),
    'path': path.resolve('node_modules/path-browserify/index.js'), 'node:path': path.resolve('node_modules/path-browserify/index.js'),
    '@eclipse-glsp/server/node': '@eclipse-glsp/server/browser'
};
const web = {
    name: 'catenary-web',
    setup(b) {
        b.onResolve({ filter: /^(node:)?(fs|url|path|crypto)$|^@eclipse-glsp\/server\/node$/ }, async args => {
            const target = ALIASES[args.path];
            return target.startsWith('/') ? { path: target } : b.resolve(target, { kind: args.kind, resolveDir: args.resolveDir });
        });
        b.onResolve({ filter: /^catenary:(notations|samples)$/ }, args => ({ path: args.path, namespace: 'catenary' }));
        b.onLoad({ filter: /.*/, namespace: 'catenary' }, async args => {
            const files = args.path === 'catenary:notations'
                ? await textFiles('src/catenary/rdf/notations', rel => !rel.endsWith('.ttl'))
                : await textFiles('test/fixtures/shapes');
            return { contents: `export default ${JSON.stringify(files)};`, loader: 'js' };
        });
    }
};
const common = {
    bundle: true, platform: 'browser', target: 'es2022', minify: true, keepNames: true, sourcemap: true, logLevel: 'warning', metafile: true,
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    loader: { '.ttf': 'file' }, plugins: [web],
    // notations.ts reads its files under import.meta.url (the in-memory /catenary/notations/).
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"file:///catenary/"' }
};
await Promise.all([
    build({ ...common, entryPoints: { main: 'src/web/main.ts' }, outdir: out, format: 'esm', external: ['./turtle-lsp/editor-lsp.js'] }),
    build({ ...common, entryPoints: { canvas: 'src/web/canvas.ts' }, outdir: out, format: 'iife' })
]);

for (const f of ['index.html', 'canvas.html', 'app.css', 'theme.css']) await copyFile(path.join('web', f), path.join(out, f));
await copyFile('LICENSE', path.join(out, 'LICENSE'));
// Monaco: the minified AMD build, without other UI languages and the language services that the page never starts.
const unused = /\/vs\/language\/(typescript|css|html)(\/|$)|nls\.messages\.[\w-]+\.js$/;
await cp('node_modules/monaco-editor/min/vs', path.join(out, 'vendor/monaco/vs'), { recursive: true, filter: src => !unused.test(src.split(path.sep).join('/')) });
await copyFile('node_modules/monaco-editor/LICENSE', path.join(out, 'vendor/monaco/LICENSE'));
execFileSync(process.execPath, ['scripts/fetch-turtle-lsp.mjs', path.join(out, 'turtle-lsp')], { stdio: 'inherit' });
console.log(`web build: ${out}/`);
