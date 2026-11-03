import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Uri, WorkspaceFolder } from 'vscode';
import { iriId } from '../src/catenary/model/ids';
import { graphOf } from '../src/model/graph-input';
import type { GraphResult } from '../src/node/turtle-api';

vi.mock('../src/node/glsp/server', () => ({ createCanvasServer: vi.fn() }));
vi.mock('@eclipse-glsp/vscode-integration', () => ({ GlspVscodeConnector: class {}, WebviewEndpoint: class {} }));
vi.mock('vscode', () => {
    const disposable = () => ({ dispose() {} });
    return {
        EventEmitter: class { event = disposable; fire() {} dispose() {} },
        RelativePattern: class {},
        workspace: {
            createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
            onDidSaveTextDocument: disposable
        },
        languages: { onDidChangeDiagnostics: disposable }
    };
});
import { WorkspaceModel } from '../src/node/workspace-model';
import { fixtureGraph } from './fixture-graph';

const result = fixtureGraph();
const file = resolve('test/fixtures/shapes/instances.trig');

test('two opens share the store; releasing one keeps edits and execute available', () => {
    const model = new WorkspaceModel({} as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    model.graph = graphOf(result, [file]).graph;
    const step = vi.fn(), close = vi.fn(), iri = 'urn:name:Bookshop';
    const first = model.openView(iri, step, close);
    const text = first.store.viewText(iri);
    const second = model.openView(iri, vi.fn());
    expect(second.store).toBe(first.store);
    expect(model.execute(iriId(iri), { kind: 'createNote', text: 'one', view: iriId(iri), at: { x: 10, y: 20 } }).ok).toBe(true);
    second.dispose();
    expect(close).not.toHaveBeenCalled();
    expect(first.store.viewText(iri)).not.toBe(text);
    expect(model.execute(iriId(iri), { kind: 'createNote', text: 'two', view: iriId(iri), at: { x: 30, y: 40 } }).ok).toBe(true);
    expect(step).toHaveBeenCalledTimes(2);
    first.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(model.execute(iriId(iri), { kind: 'createNote', text: 'closed', view: iriId(iri), at: { x: 0, y: 0 } }).ok).toBe(false);
    model.dispose();
});

test('an export opened first does not own editor steps; closing an editor leaves a read-only reference', () => {
    const model = new WorkspaceModel({} as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    model.graph = graphOf(result, [file]).graph;
    const iri = 'urn:name:Bookshop', step = vi.fn();
    const exported = model.openView(iri);
    const editor = model.openView(iri, step);
    expect(editor.store).toBe(exported.store);
    exported.dispose();
    const anotherExport = model.openView(iri);
    expect(model.execute(iriId(iri), { kind: 'createNote', text: 'owned', view: iriId(iri), at: { x: 0, y: 0 } }).ok).toBe(true);
    expect(step).toHaveBeenCalledOnce();
    editor.dispose();
    expect(model.execute(iriId(iri), { kind: 'createNote', text: 'refused', view: iriId(iri), at: { x: 0, y: 0 } }).ok).toBe(false);
    anotherExport.dispose();
    model.dispose();
});

test('a skipped duplicate cannot open as the accepted view document', async () => {
    const { CanvasEditorProvider } = await import('../src/vscode/canvas-editor');
    const model = new WorkspaceModel({} as WorkspaceFolder, () => { throw new Error('unused'); }, () => undefined);
    const loaded = graphOf(result, [file]);
    model.graph = loaded.graph;
    for (const [iri, path] of loaded.views) model.viewFiles.set(iri, path);
    vi.spyOn(model, 'ready').mockResolvedValue();
    const provider = new CanvasEditorProvider({} as Uri, () => model, () => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'catenary-duplicate-'));
    try {
        const duplicate = join(dir, 'duplicate.trig');
        writeFileSync(duplicate, readFileSync(file));
        const document = await provider.openCustomDocument({ fsPath: duplicate } as Uri, { backupId: undefined, untitledDocumentData: undefined });
        expect(document.open).toBeUndefined();
        expect(document.problem).toContain('skipped: invalid or duplicate view file');
    } finally {
        rmSync(dir, { recursive: true });
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
