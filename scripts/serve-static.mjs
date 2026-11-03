// Serves dist-web/ on http://127.0.0.1:<PORT> (default 8124) for a local check of the static site. `node scripts/serve-static.mjs [dir]`.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'dist-web'), port = Number(process.env.PORT ?? 8124);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
    '.ttf': 'font/ttf', '.map': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml', '': 'text/plain' };
createServer(async (req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
        await stat(file);
    } catch { return res.writeHead(404).end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
