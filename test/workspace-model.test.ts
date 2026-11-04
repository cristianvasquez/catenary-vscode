import { Parser } from 'n3';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import type { TextDocument, TextDocumentChangeEvent, Uri, WorkspaceFolder } from 'vscode';
import type { ViewCommand } from '../src/catenary/model/commands';
import { iriId } from '../src/catenary/model/ids';
import { tripleKey } from '../src/edit/terms';
import type { ViewEdit } from '../src/edit/executor';
import type { VersionedEdit } from '../src/model/workspace-core';
import type { TurtleApi } from '../src/node/turtle-api';

/** The listeners of onDidChangeTextDocument, and the files that findFiles gives. */
const host = vi.hoisted(() => ({ changes: [] as ((e: TextDocumentChangeEvent) => void)[], files: [] as string[], folder: undefined as unknown,
    /** openTextDocument of the real WorkspaceModel.applyEdits, and the edits that applyEdit received. */
    document: (_path: string): unknown => undefined, applied: [] as unknown[] }));

vi.mock('../src/node/glsp/server', () => ({ createCanvasServer: vi.fn() }));
vi.mock('@eclipse-glsp/vscode-integration', () => ({ GlspVscodeConnector: class {}, WebviewEndpoint: class {} }));
vi.mock('vscode', () => {
    const disposable = () => ({ dispose() {} });
    return {
        EventEmitter: class { event = disposable; fire() {} dispose() {} },
        RelativePattern: class {},
        workspace: {
            textDocuments: [],
            createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
            onDidSaveTextDocument: disposable,
            onDidChangeTextDocument: (listener: (e: TextDocumentChangeEvent) => void) => { host.changes.push(listener); return disposable(); },
            findFiles: async () => host.files.map(fsPath => ({ fsPath })),
            getWorkspaceFolder: () => host.folder,
            openTextDocument: async (uri: { path: string }) => host.document(uri.path),
            applyEdit: async (edit: { replaced: unknown[] }) => { host.applied.push(edit.replaced); return true; }
        },
        Uri: { parse: (path: string) => ({ path }), file: (path: string) => ({ path, toString: () => pathToFileURL(path).href }) },
        Range: class { constructor(readonly a: number, readonly b: number, readonly c: number, readonly d: number) {} },
        WorkspaceEdit: class { replaced: unknown[] = []; replace(uri: unknown, _range: unknown, text: string) { this.replaced.push({ uri, text }); } },
        languages: { onDidChangeDiagnostics: disposable, getDiagnostics: () => [] }
    };
});
import { ViewSession, ViewState } from '../src/node/glsp/view-session';
import type { Drawn } from '../src/read/diagram';
import { WorkspaceModel } from '../src/node/workspace-model';
import { FIXTURE, startServer } from './server';

const file = resolve('test/fixtures/shapes/instances.trig');

/** The statements of the graph `iri` of a TriG text, sorted. */
const viewQuadKeys = (text: string, iri: string) => new Parser({ format: 'application/trig' }).parse(text).filter(q => q.graph.value === iri).map(tripleKey).sort();

/** A TurtleApi over the test server. `hidden`: a document that turtle/graph does not give, as if it were in another folder of the window. */
const apiOf = (server: Awaited<ReturnType<typeof startServer>>, hidden?: string): TurtleApi => ({
    client: () => ({ isRunning: () => true, sendRequest: async <R>(method: string, params: unknown) => {
        if (method === 'turtle/query') return await server.query(params as never) as R;
        const graph = await server.graph(params as never);
        return { ...graph, edges: graph.edges.filter(e => !hidden || e.uri !== pathToFileURL(hidden).href) } as R;
    } }),
    idle: async () => {}
});

/** The host side of a view document for WorkspaceModel: `documentOf` and `applyEdits` as VS Code does them, on the test server. */
interface Host { open: Set<string>; edits: ViewEdit[][]; refuse: boolean; type(uri: string, text: string): void; beforeEdit?: () => void }

function fakeHost(model: WorkspaceModel, server: Awaited<ReturnType<typeof startServer>>): Host {
    const texts = new Map<string, string>(), opened = new Set<string>(), versions = new Map<string, number>();
    const host: Host = { open: new Set(), edits: [], refuse: false, type: (uri, text) => {
        texts.set(uri, text);
        versions.set(uri, (versions.get(uri) ?? 1) + 1);
        server.change(uri, text);
    } };
    const load = (uri: string, file: string) => {
        if (!texts.has(uri)) texts.set(uri, readFileSync(file, 'utf8'));
        if (!opened.has(uri)) { opened.add(uri); server.open(uri, texts.get(uri)!, 'trig'); }
    };
    vi.spyOn(model as unknown as { documentOf(file: string, load: boolean): Promise<unknown> }, 'documentOf').mockImplementation(async (file, loading) => {
        const uri = pathToFileURL(file).href;
        if (!host.open.has(file) && !loading) return undefined;
        load(uri, file);
        return { uri, text: texts.get(uri)!, version: versions.get(uri) ?? 1 };
    });
    // VS Code applies the edit to the open document and the language client sends didChange before the next request.
    // The version check is the host's: a document whose version moved after the command read it is not replaced.
    vi.spyOn(model as unknown as { applyEdits(edits: VersionedEdit[]): Promise<string> }, 'applyEdits').mockImplementation(async edits => {
        host.beforeEdit?.();
        host.beforeEdit = undefined;
        if (edits.some(e => e.version !== (versions.get(e.uri) ?? 1))) return 'changed';
        host.edits.push(edits);
        if (host.refuse) return 'refused';
        for (const e of edits) host.type(e.uri, e.text);
        return 'applied';
    });
    return host;
}

const V_NS = 'https://cristianvasquez.github.io/catenary/vocab/view#';

test('a canvas command is one edit of the open view document; the next draw reads the new text; refused and closed views fail', async () => {
    const server = await startServer(FIXTURE, 282);
    host.files = ['instances', 'model'].map(f => join(FIXTURE, `${f}.trig`));
    const folder = host.folder = { name: 'shapes', uri: { fsPath: FIXTURE } } as WorkspaceFolder;
    const model = new WorkspaceModel(folder, () => apiOf(server), () => undefined);
    const fake = fakeHost(model, server);
    const query = vi.spyOn(server, 'query');
    try {
        await model.refresh();
        const iri = 'urn:name:Bookshop', vid = iriId(iri), file = host.files[0], uri = pathToFileURL(file).href;
        const cardsOf = async () => (await model.diagram(vid, {})).schema.children!.filter(e => e.type === 'node:card');
        query.mockClear();
        const card = (await cardsOf())[0], at = { x: 4321, y: 1234 };
        const firstDrawQueries = query.mock.calls.length;
        const command: ViewCommand = { kind: 'setBounds', view: vid, bounds: [{ id: card.element as string, ...at }] };

        expect(await model.execute(vid, command)).toEqual({ ok: false, error: 'The view is not open in an editor.' });
        expect(fake.edits).toEqual([]);

        fake.open.add(file);
        const before = viewQuadKeys(readFileSync(file, 'utf8'), iri);
        expect(await model.execute(vid, command)).toMatchObject({ ok: true });
        expect(fake.edits).toHaveLength(1);
        const [[edit]] = fake.edits;
        expect(edit.uri).toBe(uri);
        // The text parsed back: the statements of the file with the new x and y of the moved placement, nothing else.
        const after = viewQuadKeys(edit.text, iri);
        const removed = before.filter(k => !after.includes(k)), added = after.filter(k => !before.includes(k));
        expect(removed.map(k => k.split(' ')[1]).sort()).toEqual([`<${V_NS}x>`, `<${V_NS}y>`]);
        expect(added.map(k => k.split(' ').slice(1).join(' ')).sort()).toEqual([`<${V_NS}x> "4321"^^<http://www.w3.org/2001/XMLSchema#integer>`, `<${V_NS}y> "1234"^^<http://www.w3.org/2001/XMLSchema#integer>`]);
        expect(new Set([...removed, ...added].map(k => k.split(' ')[0])).size).toBe(1);
        // After didChange the next draw shows the new position and reuses the figure prefetch.
        model.viewChanged();
        query.mockClear();
        expect((await cardsOf()).find(c => c.element === card.element)!.position).toEqual(at);
        const secondDrawQueries = query.mock.calls.length;
        expect(secondDrawQueries).toBe(0);
        expect(secondDrawQueries).toBeLessThan(firstDrawQueries);

        // A text change of the document (a text editor, an undo) is drawn too.
        fake.type(uri, readFileSync(file, 'utf8'));
        model.viewChanged();
        query.mockClear();
        expect((await cardsOf()).find(c => c.element === card.element)!.position).toEqual(card.position);
        expect(query.mock.calls.length).toBe(0);

        // A successful model refresh invalidates the kept statements through the generation check.
        await model.refresh();
        query.mockClear();
        expect((await cardsOf()).find(c => c.element === card.element)!.position).toEqual(card.position);
        expect(query.mock.calls.length).toBe(0);

        // A text change between the read of the document and the edit wins over the command.
        fake.beforeEdit = () => fake.type(uri, readFileSync(file, 'utf8') + '\n');
        expect(await model.execute(vid, command)).toEqual({ ok: false, error: 'The view changed during the edit. Do it again.' });
        expect(fake.edits).toHaveLength(1);

        fake.refuse = true;
        expect(await model.execute(vid, command)).toEqual({ ok: false, error: 'The editor refused the edit of the view file.' });
    } finally {
        model.dispose();
        host.files = [];
        host.folder = undefined;
        await server.stop();
    }
    // Delayed host work must not write to the closed JSON-RPC transport.
    const uri = pathToFileURL(file).href;
    server.open(uri, '', 'trig');
    server.change(uri, '');
    await expect(server.query({ query: 'ASK { ?s ?p ?o }' })).rejects.toThrow('the test server is stopped');
    await expect(server.graph({})).rejects.toThrow('the test server is stopped');
    await expect(server.port().select('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toThrow('not running');
    await server.stop();
}, 20000);

test('a view-only command preserves completed instance records for the next text-first draw', async () => {
    const server = await startServer(FIXTURE, 282);
    const folder = { name: 'shapes', uri: { fsPath: FIXTURE } } as WorkspaceFolder;
    const model = new WorkspaceModel(folder, () => apiOf(server), () => undefined);
    const fake = fakeHost(model, server);
    const iri = 'urn:name:Bookshop', vid = iriId(iri), file = join(FIXTURE, 'instances.trig');
    try {
        await model.refresh();
        // No open document: this awaits a complete draw and stores both figures and instance records.
        const complete = await model.diagram(vid, {});
        expect(Object.keys(complete.doc.instances).length).toBeGreaterThan(0);
        const cards = complete.schema.children!.filter(e => e.type === 'node:card');
        expect(cards.length).toBeGreaterThan(0);
        fake.open.add(file);
        expect(await model.execute(vid, { kind: 'createNote', view: vid, text: 'keep card content', at: { x: 10, y: 20 } })).toMatchObject({ ok: true });
        const query = vi.spyOn(server, 'query');
        const next = await model.diagram(vid, {});
        expect(next.phase).toBe(1);
        expect(query).not.toHaveBeenCalled();
        expect(next.doc.instances).toEqual(complete.doc.instances);
        expect(next.doc.relations).toEqual(complete.doc.relations);
        // Hidden-neighbour counts are completed asynchronously; card labels, types and fields must already be present.
        const content = (e: typeof cards[number]) => {
            const { hiddenIn: _in, hiddenOut: _out, hiddenTargets: _targets, ...card } = e;
            return card;
        };
        expect(next.schema.children!.filter(e => e.type === 'node:card').map(content)).toEqual(cards.map(content));
    } finally {
        model.dispose();
        await server.stop();
    }
}, 20000);

test('the session submits the text model before delayed requests answer, then a content update', async () => {
    const server = await startServer(FIXTURE, 282);
    const folder = { name: 'shapes', uri: { fsPath: FIXTURE } } as WorkspaceFolder;
    const model = new WorkspaceModel(folder, () => apiOf(server), () => undefined);
    const fake = fakeHost(model, server);
    const iri = 'urn:name:Bookshop%20model', vid = iriId(iri), file = join(FIXTURE, 'model.trig');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let answered = 0, started = 0;
    const sent: Drawn[] = [];
    const session = new ViewSession(), state = new ViewState();
    Object.assign(state, { store: model });
    Object.assign(session, { state, submission: { submitModel: async () => { sent.push(state.drawn); return []; } }, dispatcher: { dispatchAll: async () => {} }, sessions: { addListener: () => {} } });
    try {
        await model.refresh();
        // Prime the retained index through the no-editor path.
        await model.diagram(vid, {});
        fake.open.add(file);
        const query = server.query.bind(server);
        vi.spyOn(server, 'query').mockImplementation(async (...args) => { started++; await gate; const result = await query(...args); answered++; return result; });
        session.start(vid);
        model.viewChanged();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].phase).toBe(1);
        expect(answered).toBe(0);
        await vi.waitFor(() => expect(started).toBeGreaterThan(0));
        const layout = sent[0].schema.children!.map(e => [e.id, e.position, e.size, e.vertices]);
        release();
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1].phase).toBe(2);
        expect(sent[1].schema.children!.map(e => [e.id, e.position, e.size, e.vertices])).toEqual(layout);
    } finally {
        release();
        model.dispose();
        await server.stop();
    }
}, 20000);

test('a change of an open view document redraws the canvases after 100 ms; a model document schedules a refresh', async () => {
    vi.useFakeTimers();
    host.folder = { name: 'shapes', uri: { fsPath: FIXTURE } } as WorkspaceFolder;
    const model = new WorkspaceModel(host.folder as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    try {
        model.viewFiles.set('urn:name:Bookshop', join(FIXTURE, 'instances.trig'));
        const fired = vi.fn(), schedule = vi.spyOn(model as unknown as { schedule(): void }, 'schedule').mockImplementation(() => undefined);
        model.onDidChange(fired);
        const change = (fsPath: string) => host.changes.at(-1)!({ document: { uri: { fsPath } }, contentChanges: [{}] } as unknown as TextDocumentChangeEvent);
        change(join(FIXTURE, 'instances.trig'));
        change(join(FIXTURE, 'instances.trig'));
        vi.advanceTimersByTime(99);
        expect(fired).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fired).toHaveBeenCalledOnce();
        expect(schedule).not.toHaveBeenCalled();
        change(join(FIXTURE, 'data.ttl'));
        expect(schedule).toHaveBeenCalledOnce();
    } finally {
        model.dispose();
        host.folder = undefined;
        vi.useRealTimers();
    }
});

test('WorkspaceModel.applyEdits: the documents load first; a version that moved during the load fails the edit, nothing is applied', async () => {
    const model = new WorkspaceModel({} as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    const apply = (model as unknown as { applyEdits(edits: VersionedEdit[]): Promise<string> }).applyEdits.bind(model);
    const doc = (path: string, version: number) => ({ uri: { path }, version, lineCount: 1, validateRange: (r: unknown) => r });
    try {
        host.applied = [];
        host.document = path => doc(path, 3);
        expect(await apply([{ uri: 'a.trig', text: 'A', version: 3 }, { uri: 'b.trig', text: 'B', version: 3 }])).toBe('applied');
        expect(host.applied).toEqual([[{ uri: { path: 'a.trig' }, text: 'A' }, { uri: { path: 'b.trig' }, text: 'B' }]]);
        // A keystroke in b.trig while the documents load: its version is 4, the command read 3.
        host.document = path => doc(path, path === 'b.trig' ? 4 : 3);
        expect(await apply([{ uri: 'a.trig', text: 'A', version: 3 }, { uri: 'b.trig', text: 'B', version: 3 }])).toBe('changed');
        expect(host.applied).toHaveLength(1);
    } finally {
        model.dispose();
    }
});

test('a skipped duplicate cannot open as the accepted view document', async () => {
    const { CanvasEditorProvider } = await import('../src/vscode/canvas-editor');
    const model = new WorkspaceModel({} as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    model.viewFiles.set('urn:name:Bookshop', file);
    vi.spyOn(model, 'ready').mockResolvedValue();
    const refresh = vi.spyOn(model, 'refresh').mockResolvedValue();
    const viewOf = vi.spyOn(model, 'viewOfDocument').mockResolvedValue({ iri: 'urn:name:Bookshop' });
    const provider = new CanvasEditorProvider({} as Uri, () => model, () => undefined);
    try {
        const text = (fsPath: string) => ({ uri: { fsPath } }) as unknown as TextDocument;
        const accepted = await provider.viewDocumentOf(text(file));
        expect(accepted?.iri).toBe('urn:name:Bookshop');
        expect(refresh).not.toHaveBeenCalled();
        // The folder does not have this file for the view: it is read again; still not: a skipped duplicate.
        const duplicate = await provider.viewDocumentOf(text('/elsewhere/duplicate.trig'));
        expect(refresh).toHaveBeenCalledOnce();
        expect(duplicate?.iri).toBeUndefined();
        expect(duplicate?.problem).toContain('skipped: invalid or duplicate view file');
        viewOf.mockResolvedValue({ problem: 'two view graphs' });
        expect((await provider.viewDocumentOf(text(file)))?.problem).toBe(`${file}: two view graphs`);
        // A .trig document without a view:View is a model file: no view document, the text editor opens it.
        viewOf.mockResolvedValue(undefined);
        expect(await provider.viewDocumentOf(text('/elsewhere/model.trig'))).toBeUndefined();
    } finally {
        provider.dispose();
        model.dispose();
    }
});

test('a refresh over the port reads the view files, the shapes and the diagram; a model document change schedules a refresh', async () => {
    const server = await startServer(FIXTURE, 282);
    const api = apiOf(server);
    host.files = ['instances', 'model'].map(f => join(FIXTURE, `${f}.trig`));
    const folder = host.folder = { name: 'shapes', uri: { fsPath: FIXTURE } } as WorkspaceFolder;
    const model = new WorkspaceModel(folder, () => api, () => undefined);
    try {
        await model.refresh();
        expect(model.error).toBeUndefined();
        expect(model.generation).toBe(1);
        expect(Object.fromEntries(model.viewFiles)).toEqual({ 'urn:name:Bookshop': host.files[0], 'urn:name:Bookshop%20model': host.files[1] });
        expect(model.manifest.file).toBe(join(FIXTURE, 'prefixes.ttl'));
        expect(model.modelFiles).toEqual(['cities.ttl', 'data.ttl', 'shapes.ttl'].map(f => join(FIXTURE, f)));
        const { schema, doc } = await model.diagram(iriId('urn:name:Bookshop'), {});
        expect(schema.children!.filter(e => e.type === 'node:card')).toHaveLength(7);
        expect(doc.views[iriId('urn:name:Bookshop')]).toBeDefined();
        const schedule = vi.spyOn(model as unknown as { schedule(): void }, 'schedule').mockImplementation(() => undefined);
        const change = (fsPath: string) => host.changes.at(-1)!({ document: { uri: { fsPath } }, contentChanges: [{}] } as unknown as TextDocumentChangeEvent);
        change(join(FIXTURE, 'data.ttl'));
        // A new empty model document is in no list yet; a view file and a file that is not RDF do not refresh the model.
        change(join(FIXTURE, 'new.ttl'));
        change(host.files[0]);
        change(join(FIXTURE, 'readme.md'));
        expect(schedule).toHaveBeenCalledTimes(2);
        await model.refresh();
        expect(model.generation).toBe(2);
        // The server holds the view of another folder; this folder's canvas does not draw it.
        const other = new WorkspaceModel(folder, () => apiOf(server, host.files[0]), () => undefined);
        try {
            await other.refresh();
            expect(other.viewFiles.has('urn:name:Bookshop')).toBe(false);
            expect((await other.diagram(iriId('urn:name:Bookshop'), {})).schema).toEqual({ type: 'graph', id: 'root', children: [] });
        } finally {
            other.dispose();
        }
    } finally {
        model.dispose();
        host.files = [];
        host.folder = undefined;
        await server.stop();
    }
}, 20000);
