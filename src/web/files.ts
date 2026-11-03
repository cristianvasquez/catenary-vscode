// The workspace files of the page: paths relative to the workspace root, kept in the in-memory file system (shims/fs.ts) and in
// localStorage. Nothing leaves the browser. A page without stored files starts with the samples (test/fixtures/shapes).
import { files } from './shims/fs';

/** The workspace root in the in-memory file system; turtle-lsp's browser editor uses the same root URI. */
export const ROOT = '/work';
const KEY = 'catenary-web-files';

export const pathOf = (rel: string) => `${ROOT}/${rel}`;
/** The file URI of an absolute path of the in-memory file system. */
export const fileUriOf = (path: string) => 'file://' + path.split('/').map(encodeURIComponent).join('/');
export const uriOf = (rel: string) => fileUriOf(pathOf(rel));
export function relOfUri(uri: string): string | undefined {
    const prefix = `file://${ROOT}/`;
    return uri.startsWith(prefix) ? uri.slice(prefix.length).split('/').map(decodeURIComponent).join('/') : undefined;
}
export const relOfPath = (path: string) => path.startsWith(ROOT + '/') ? path.slice(ROOT.length + 1) : undefined;

export type FileEvent = { kind: 'change' | 'create' | 'delete'; rel: string };

export class FileStore {
    readonly unstored = new Set<string>();
    protected readonly listeners = new Set<(e: FileEvent) => void>();

    constructor(protected readonly samples: Record<string, string>) {
        let stored: Record<string, string> | undefined;
        try { stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined; } catch { stored = undefined; }
        for (const [rel, text] of Object.entries(stored ?? samples)) files.set(pathOf(rel), text);
    }

    /** The relative paths, sorted. */
    list(): string[] {
        return [...files.keys()].flatMap(p => relOfPath(p) ?? []).sort();
    }

    has(rel: string): boolean { return files.has(pathOf(rel)); }

    read(rel: string): string | undefined { return files.get(pathOf(rel)); }

    write(rel: string, text: string): boolean {
        const kind = this.has(rel) ? 'change' : 'create';
        if (kind === 'change' && this.read(rel) === text && !this.unstored.has(rel)) return true;
        files.set(pathOf(rel), text);
        const stored = this.persist();
        if (stored) this.unstored.clear();
        else this.unstored.add(rel);
        this.emit({ kind, rel });
        return stored;
    }

    delete(rel: string): boolean {
        if (!files.delete(pathOf(rel))) return true;
        const stored = this.persist();
        if (stored) this.unstored.clear();
        else this.unstored.add(rel);
        this.emit({ kind: 'delete', rel });
        return stored;
    }

    /** Back to the samples: every file is deleted, then the samples are created. */
    reset(): void {
        for (const rel of this.list()) this.delete(rel);
        for (const [rel, text] of Object.entries(this.samples)) this.write(rel, text);
    }

    onDidChange(listener: (e: FileEvent) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    protected emit(e: FileEvent): void {
        for (const l of [...this.listeners]) l(e);
    }

    protected persist(): boolean {
        try {
            localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(this.list().map(rel => [rel, this.read(rel)!]))));
            return true;
        } catch { return false; /* storage full or blocked: the files stay in memory for this page */ }
    }
}
