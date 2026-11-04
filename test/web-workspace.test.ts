// Kata thfz: the port of the browser page (turtle/query over LspClient) and the edits of WebWorkspace (buffer + FileStore), with a fake client.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MAX_ROWS } from '../src/model/port';
import type { VersionedEdit } from '../src/model/workspace-core';
import { FileStore, pathOf, uriOf } from '../src/web/files';
import { webPort } from '../src/web/port';
import { files } from '../src/web/shims/fs';
import type { LspClient } from '../src/web/turtle-lsp/editor-lsp.js';
import { type Buffers, WebWorkspace } from '../src/web/workspace';

beforeEach(() => {
    files.clear();
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
});

afterEach(() => {
    files.clear();
    vi.unstubAllGlobals();
});

const client = (request: (method: string, params: unknown) => Promise<unknown>) => ({ request, notify: vi.fn() }) as unknown as LspClient;

test('webPort sends turtle/query with the file paths as file URIs and reads the rows', async () => {
    const request = vi.fn(async () => ({ kind: 'select', results: { bindings: [{ s: { type: 'uri', value: 'urn:a' }, b: { type: 'bnode', value: '1:2' } }] } }));
    const rows = await webPort(client(request)).select('SELECT ?s ?b WHERE { ?s ?p ?b }', [pathOf('a b.ttl')]);
    expect(request).toHaveBeenCalledWith('turtle/query', { query: 'SELECT ?s ?b WHERE { ?s ?p ?b }', maxRows: MAX_ROWS, files: ['file:///work/a%20b.ttl'] });
    expect(rows.map(r => [r.s.value, r.b.value])).toEqual([['urn:a', 'urn:skolem:blank:000001-00000002']]);
    await webPort(client(request)).select('ASK {}');
    expect(request).toHaveBeenLastCalledWith('turtle/query', { query: 'ASK {}', maxRows: MAX_ROWS });
});

/** A WebWorkspace over the FileStore `store` with buffers that hold the file text at version 1. */
function workspace(store: FileStore) {
    const buffers = new Map<string, { text: string; version: number }>();
    const b: Buffers = {
        get: rel => buffers.get(rel),
        open: rel => void buffers.set(rel, { text: store.read(rel) ?? '', version: 1 }),
        replace: (rel, text) => void buffers.set(rel, { text, version: (buffers.get(rel)?.version ?? 0) + 1 }),
    };
    const warn = vi.fn();
    const ws = new WebWorkspace(client(async () => { throw new Error('no server'); }), store, b, () => undefined, warn);
    const apply = (edits: VersionedEdit[]) => (ws as unknown as { applyEdits(e: VersionedEdit[]): Promise<string> }).applyEdits(edits);
    const documents = () => (ws as unknown as { documentsOf(): string[] }).documentsOf();
    return { ws, buffers, b, warn, apply, documents };
}

test('the documents are the Turtle and TriG files of the FileStore', () => {
    const { documents } = workspace(new FileStore({ 'a.ttl': '', 'v.trig': '', 'readme.md': '' }));
    expect(documents()).toEqual([pathOf('a.ttl'), pathOf('v.trig')]);
});

test('an edit replaces the buffer and writes the file; another version or another file is not edited', async () => {
    const store = new FileStore({ 'v.trig': 'old' });
    const { b, buffers, apply } = workspace(store);
    b.open('v.trig');
    expect(await apply([{ uri: uriOf('v.trig'), text: 'new', version: 2 }])).toBe('changed');
    expect(store.read('v.trig')).toBe('old');
    expect(await apply([{ uri: uriOf('w.trig'), text: 'new', version: 1 }])).toBe('refused');
    expect(await apply([{ uri: uriOf('v.trig'), text: 'new', version: 1 }])).toBe('applied');
    expect(buffers.get('v.trig')).toEqual({ text: 'new', version: 2 });
    expect(store.read('v.trig')).toBe('new');
});

test('a write that the browser storage refuses warns and keeps the edit', async () => {
    const store = new FileStore({ 'v.trig': 'old' });
    const { b, apply, warn } = workspace(store);
    b.open('v.trig');
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new Error('full'); }) });
    expect(await apply([{ uri: uriOf('v.trig'), text: 'new', version: 1 }])).toBe('applied');
    expect(store.read('v.trig')).toBe('new');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Not stored'));
});
