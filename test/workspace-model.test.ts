import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import type { TextDocument, TextDocumentChangeEvent, Uri, WorkspaceFolder } from 'vscode';
import type { ViewCommand } from '../src/catenary/model/commands';
import { iriId } from '../src/catenary/model/ids';
import { parseRdfSync } from '../src/catenary/rdf-files/oxigraph-store';
import { tripleKey } from '../src/edit/terms';
import type { ViewEdit } from '../src/edit/executor';
import { graphOf } from '../src/model/graph-input';
import type { TurtleApi } from '../src/node/turtle-api';

/** The listeners of onDidChangeTextDocument, and the files that findFiles gives. */
const host = vi.hoisted(() => ({ changes: [] as ((e: TextDocumentChangeEvent) => void)[], files: [] as string[], folder: undefined as unknown }));

vi.mock('../src/node/glsp/server', () => ({ createCanvasServer: vi.fn() }));
vi.mock('@eclipse-glsp/vscode-integration', () => ({ GlspVscodeConnector: class {}, WebviewEndpoint: class {} }));
vi.mock('vscode', () => {
    const disposable = () => ({ dispose() {} });
    return {
        EventEmitter: class { event = disposable; fire() {} dispose() {} },
        RelativePattern: class {},
        workspace: {
            createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
            onDidSaveTextDocument: disposable,
            onDidChangeTextDocument: (listener: (e: TextDocumentChangeEvent) => void) => { host.changes.push(listener); return disposable(); },
            findFiles: async () => host.files.map(fsPath => ({ fsPath })),
            getWorkspaceFolder: () => host.folder
        },
        languages: { onDidChangeDiagnostics: disposable, getDiagnostics: () => [] }
    };
});
import { WorkspaceModel } from '../src/node/workspace-model';
import { FIXTURE, fixtureGraph } from './fixture-graph';
import { startServer } from './server';

const result = fixtureGraph();
const file = resolve('test/fixtures/shapes/instances.trig');

/** The statements of the graph `iri` of a TriG text, sorted. */
const viewQuadKeys = (text: string, iri: string) => parseRdfSync(text, 'application/trig').filter(q => q.graph.value === iri).map(tripleKey).sort();

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
interface Host { open: Set<string>; edits: ViewEdit[][]; refuse: boolean; type(uri: string, text: string): void }

function fakeHost(model: WorkspaceModel, server: Awaited<ReturnType<typeof startServer>>): Host {
    const texts = new Map<string, string>(), opened = new Set<string>();
    const host: Host = { open: new Set(), edits: [], refuse: false, type: (uri, text) => { texts.set(uri, text); server.change(uri, text); } };
    const load = (uri: string, file: string) => {
        if (!texts.has(uri)) texts.set(uri, readFileSync(file, 'utf8'));
        if (!opened.has(uri)) { opened.add(uri); server.open(uri, texts.get(uri)!, 'trig'); }
    };
    vi.spyOn(model as unknown as { documentOf(file: string, load: boolean): Promise<unknown> }, 'documentOf').mockImplementation(async (file, loading) => {
        const uri = pathToFileURL(file).href;
        if (!host.open.has(file) && !loading) return undefined;
        load(uri, file);
        return { uri, text: texts.get(uri)! };
    });
    // VS Code applies the edit to the open document and the language client sends didChange before the next request.
    vi.spyOn(model as unknown as { applyEdits(edits: ViewEdit[]): Promise<boolean> }, 'applyEdits').mockImplementation(async edits => {
        host.edits.push(edits);
        if (host.refuse) return false;
        for (const e of edits) host.type(e.uri, e.text);
        return true;
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
    try {
        await model.refresh();
        const iri = 'urn:name:Bookshop', vid = iriId(iri), file = host.files[0], uri = pathToFileURL(file).href;
        const cardsOf = async () => (await model.diagram(vid, {})).schema.children!.filter(e => e.type === 'node:card');
        const card = (await cardsOf())[0], at = { x: 4321, y: 1234 };
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
        // After didChange the next draw shows the new position.
        expect((await cardsOf()).find(c => c.element === card.element)!.position).toEqual(at);

        // A text change of the document (a text editor, an undo) is drawn too.
        fake.type(uri, readFileSync(file, 'utf8'));
        expect((await cardsOf()).find(c => c.element === card.element)!.position).toEqual(card.position);

        fake.refuse = true;
        expect(await model.execute(vid, command)).toEqual({ ok: false, error: 'The editor refused the edit of the view file.' });
    } finally {
        model.dispose();
        host.files = [];
        host.folder = undefined;
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

test('a skipped duplicate cannot open as the accepted view document', async () => {
    const { CanvasEditorProvider } = await import('../src/vscode/canvas-editor');
    const model = new WorkspaceModel({} as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    model.viewFiles.set('urn:name:Bookshop', file);
    vi.spyOn(model, 'ready').mockResolvedValue();
    vi.spyOn(model, 'refresh').mockResolvedValue();
    const holdsView = vi.spyOn(model, 'holdsView').mockResolvedValue(true);
    const provider = new CanvasEditorProvider({} as Uri, () => model, () => undefined);
    try {
        const text = (fsPath: string) => ({ uri: { fsPath } }) as unknown as TextDocument;
        const accepted = await provider.viewDocumentOf(text(file));
        expect(accepted?.iri).toBe('urn:name:Bookshop');
        const duplicate = await provider.viewDocumentOf(text('/elsewhere/duplicate.trig'));
        expect(duplicate?.iri).toBeUndefined();
        expect(duplicate?.problem).toContain('skipped: invalid or duplicate view file');
        // A .trig document without a view:View is a model file: no view document, the text editor opens it.
        holdsView.mockResolvedValue(false);
        expect(await provider.viewDocumentOf(text('/elsewhere/model.trig'))).toBeUndefined();
    } finally {
        provider.dispose();
        model.dispose();
    }
});

test('bad and duplicate view files are reported without blocking a valid view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-views-'));
    try {
        const bad = join(dir, 'bad.trig'), duplicate = join(dir, 'duplicate.trig');
        writeFileSync(bad, 'not valid TriG {');
        writeFileSync(duplicate, readFileSync(file));
        const { graph, views, skipped } = graphOf(result, [bad, file, duplicate]);
        expect(views.get('urn:name:Bookshop')).toBe(file);
        expect(graph.match(null, null, null).length).toBeGreaterThan(0);
        expect(skipped.map(s => s.file)).toEqual([bad, duplicate]);
        expect(skipped[0].reason).not.toBe('');
        expect(skipped[1].reason).toBe('duplicate view urn:name:Bookshop');
    } finally {
        rmSync(dir, { recursive: true });
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
