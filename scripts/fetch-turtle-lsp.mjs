// Fetches the turtle-lsp browser engine (engine.wasm and the page modules that run it) from the turtle-lsp GitHub Pages site and checks
// each file against the SHA-256 pinned below. turtle-lsp publishes no versioned web build: the site changes when upstream deploys. A
// checked copy is kept in .cache/turtle-lsp-web/, so a later upstream deploy does not break a local build that has the cache.
//
//   node scripts/fetch-turtle-lsp.mjs <dest>    copy the checked files to <dest>
//   node scripts/fetch-turtle-lsp.mjs --pin     download the current site and print new pins (review them, then paste them below)
//
// Pinned: turtle-lsp 0.13.1, commit 4488f0f4154ba102e9dfd67c15bc610b562646e8 (the site's modules equal web/app/ at that commit).
// License: MIT (LICENSE); the crates and data in the engine: THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://abhishekkundu25.github.io/turtle-lsp/';
const PINS = {
    'engine.wasm': '0cfdfa16aea3e4e0a25b2358ce2163cba48b4ec0a6f37b878ad4af8d93845891',
    'engine.js': '5a50e8262278db63421da5ead5554cf6aad92d50c403ccf473f9877941fbcc83',
    'lsp-host.js': '934ba3e600f79252d15684d4bc2dc43e44ae3a74b6b1565beaefd78fd3739bf0',
    'lsp-worker.js': '2415737ba44b94751683fe0ae0c6ecc21dbb302f3581e4b528d991629ec58062',
    'editor-lsp.js': 'a48431ee94cb0bef70c934e4016d598e555ea5db573fe1b53696e537d267747d',
    'vendor/LICENSE': 'b3a3376679111825f2720b499cd45c89ead8733b049d9e818e9fe26680bd3e03',
    'vendor/THIRD_PARTY_NOTICES.md': 'add7c938fb11508b9d87b3788c7c11927cc3d09403749bb111c6468696405726'
};
const cache = path.resolve('.cache/turtle-lsp-web');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const download = async file => {
    const r = await fetch(SITE + file);
    if (!r.ok) throw new Error(`${SITE + file}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
};

if (process.argv[2] === '--pin') {
    for (const file of Object.keys(PINS)) console.log(`    '${file}': '${sha(await download(file))}',`);
    process.exit(0);
}

const dest = process.argv[2];
if (!dest) throw new Error('usage: fetch-turtle-lsp.mjs <dest> | --pin');
await mkdir(cache, { recursive: true });
for (const [file, pin] of Object.entries(PINS)) {
    const cached = path.join(cache, file);
    let bytes = await readFile(cached).catch(() => undefined);
    if (!bytes || sha(bytes) !== pin) {
        bytes = await download(file);
        if (sha(bytes) !== pin) {
            throw new Error(`${SITE + file} changed upstream (SHA-256 ${sha(bytes)}, pinned ${pin}). Run node scripts/fetch-turtle-lsp.mjs --pin, check the new turtle-lsp web modules, and update PINS.`);
        }
        await mkdir(path.dirname(cached), { recursive: true });
        await writeFile(cached, bytes);
    }
    const target = path.join(dest, file.startsWith('vendor/') ? file.replace('vendor/', '') : file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(cached, target);
}
