// Browser stand-in for node:fs in the web build (scripts/build-web.mjs): synchronous reads of an in-memory file system.
// The page keeps the workspace files and the bundled notations here (web/files.ts); the shared code reads them as it reads disk files.

/** Absolute path to text. */
export const files = new Map<string, string>();

const normal = (p: string) => p.replace(/\/+/g, '/').replace(/\/$/, '');

function missing(p: string): never {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
}

export function readFileSync(p: string, _encoding?: unknown): string {
    return files.get(normal(p)) ?? missing(p);
}

/** Asynchronous text read for the shared view-file parser (node:fs/promises). */
export async function readFile(p: string, _encoding?: unknown): Promise<string> {
    return readFileSync(p, _encoding);
}

export function existsSync(p: string): boolean {
    const n = normal(p);
    return files.has(n) || [...files.keys()].some(f => f.startsWith(n + '/'));
}

/** The names of the direct children of the directory `p`. */
export function readdirSync(p: string): string[] {
    const prefix = normal(p) + '/';
    const names = new Set<string>();
    for (const f of files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]);
    if (!names.size) missing(p);
    return [...names].sort();
}

export default { readFileSync, existsSync, readdirSync };
