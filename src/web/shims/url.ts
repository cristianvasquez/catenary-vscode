// Browser stand-in for node:url in the web build: file URLs of the in-memory file system (shims/fs.ts).

export function fileURLToPath(url: string | URL): string {
    const u = typeof url === 'string' ? new URL(url) : url;
    if (u.protocol !== 'file:') throw new TypeError(`The URL must be of scheme file: ${u.href}`);
    return decodeURIComponent(u.pathname);
}

export function pathToFileURL(path: string): URL {
    return new URL('file://' + path.split('/').map(encodeURIComponent).join('/'));
}

export default { fileURLToPath, pathToFileURL };
