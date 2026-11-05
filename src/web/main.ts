// The browser page of Catenary: a file list, Monaco text editors and Catenary canvases, with turtle-lsp (engine.wasm) in a worker and the
// GLSP server in this page. Everything runs in the tab; files stay in localStorage. VS Code glue replaced here: the custom editor
// (vscode/canvas-editor.ts: undo steps, save, insert, open in, drops, paste) and the workspace folder (node/workspace-model.ts).
import './shims/globals';
import './notations';
import '@vscode/codicons/dist/codicon.css';
import { StatusAction } from '@eclipse-glsp/protocol';
import samples from 'catenary:samples';
import pkg from '../../package.json';
import { boxes } from '../catenary/model/doc';
import { idIri, iriId } from '../catenary/model/ids';
import { NS } from '../catenary/model/terms';
import { DROP_FILES_EVENT, INSERT_ELEMENT, OPEN_IN_EVENT, OPEN_TEXT } from '../common/protocol';
import { locateParserFiles } from '../edit/text-patch';
import { toEngine } from '../model/port';
import { newViewText, viewFileName } from '../node/new-view';
import { instanceLabels } from '../read/choices';
import { factsOf, inShapesOf } from '../read/neighbors';
import { viewLabelsOf } from '../read/view';
import { pasteTurtle } from '../vscode/paste-rdf';
import { PASTE_RDF_EVENT } from '../webview/clipboard';
import type { PreferenceValues } from '../webview/preferences';
import type { CanvasStartMessage, FromCanvas, ToCanvas } from './canvas';
import { FileStore, pathOf, relOfPath, relOfUri, uriOf } from './files';
import { createCanvasServer } from './server';
import { LspClient, connect, languageOf, markers, registerSyntax, type LspRange } from './turtle-lsp/editor-lsp.js';
import { WebWorkspace } from './workspace';
import { zip } from './zip';

// Monaco is loaded by its AMD loader (loadMonaco); its types are not part of this build.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;
declare const require: { config(o: unknown): void; (deps: string[], ok: (m: Monaco) => void, err: (e: unknown) => void): void };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The defaults of the catenary.* settings (package.json), as VS Code sends them to the canvas. */
const preferences: PreferenceValues = Object.fromEntries(Object.entries(pkg.contributes.configuration.properties).map(([name, p]) => [name, (p as { default: unknown }).default]));

// ---------------------------------------------------------------------------------------------------------------------------------
// Messages

function toast(text: string, severity: 'info' | 'warning' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${severity}`;
    el.textContent = text;
    $('toasts').append(el);
    setTimeout(() => el.remove(), severity === 'warning' ? 9000 : 5000);
}

const log = (line: string) => console.info(`[catenary] ${line}`);

interface PickItem { label: string; description?: string; detail?: string; action?: boolean }

/** A quick pick: a filter field over a list; `many`: check boxes and an OK button. Resolves with the picked items; [] on Escape.
 *  An `action` row has no check box: a click or Enter on it closes the pick at once with the checked rows and that row. */
function pick<T extends PickItem>(items: T[], placeholder: string, many = false): Promise<T[]> {
    return new Promise(resolve => {
        const dialog = $<HTMLDialogElement>('picker'), input = dialog.querySelector('input')!, list = dialog.querySelector('ul')!, ok = dialog.querySelector('button')!;
        const checked = new Set<T>();
        let active = 0, shown: T[] = [];
        input.value = '';
        input.placeholder = placeholder;
        ok.hidden = !many;
        const done = (picked: T[]) => { dialog.close(); dialog.onclose = null; resolve(picked); };
        const render = () => {
            const q = input.value.toLowerCase();
            shown = items.filter(i => [i.label, i.description, i.detail].some(t => t?.toLowerCase().includes(q)));
            active = Math.min(active, Math.max(0, shown.length - 1));
            list.replaceChildren(...shown.map((item, i) => {
                const li = document.createElement('li');
                li.className = (i === active ? 'active ' : '') + (checked.has(item) ? 'checked' : '');
                li.innerHTML = `${many && !item.action ? '<input type="checkbox" tabindex="-1">' : ''}<span class="label"></span><span class="detail"></span><span class="description"></span>`;
                if (many && !item.action) li.querySelector<HTMLInputElement>('input')!.checked = checked.has(item);
                li.querySelector('.label')!.textContent = item.label;
                li.querySelector('.detail')!.textContent = item.detail ?? '';
                li.querySelector('.description')!.textContent = item.description ?? '';
                li.onclick = () => { if (!many) done([item]); else if (item.action) done([...checked, item]); else { toggle(item); render(); } };
                return li;
            }));
            list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
        };
        const toggle = (item: T) => { if (!checked.delete(item)) checked.add(item); };
        input.oninput = () => { active = 0; render(); };
        input.onkeydown = e => {
            if (e.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); render(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
            else if (e.key === ' ' && many && shown[active] && !shown[active].action && !input.value) { toggle(shown[active]); render(); e.preventDefault(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (!many) { if (shown[active]) done([shown[active]]); }
                else if (shown[active]?.action) done([...checked, shown[active]]);
                else done(checked.size ? [...checked] : shown[active] ? [shown[active]] : []);
            }
        };
        ok.onclick = () => done([...checked]);
        // The close event of a previous pick arrives after this pick opened the dialog again: only a closed dialog resolves.
        dialog.onclose = () => { if (!dialog.open) resolve([]); };
        render();
        dialog.showModal();
        input.focus();
    });
}

function ask(question: string, value = ''): string | undefined {
    const answer = prompt(question, value);
    return answer?.trim() || undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Start: Monaco, turtle-lsp, the workspace and the GLSP server

// The text patch of a canvas command (src/edit/text-patch.ts) fetches its parser next to the page (scripts/build-web.mjs copies it).
locateParserFiles(name => new URL(name, location.href).href);
const files = new FileStore(samples);
// Monaco 0.52.2: editor.setModel disposes the word highlighter, whose Delayer rejects a pending promise with a CancellationError that no
// code awaits. Drop exactly that rejection (name and message "Canceled", thrown from the Monaco bundle); every other one stays reported.
window.addEventListener('unhandledrejection', e => {
    const r = e.reason as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
    if (r?.name === 'Canceled' && r.message === 'Canceled' && typeof r.stack === 'string' && /\/vendor\/monaco\/vs\/editor\/editor\.main\.js:/.test(r.stack.split('\n')[1] ?? '')) e.preventDefault();
});
let monaco: Monaco, editor: Monaco;
const lsp = new LspClient(new URL('turtle-lsp/lsp-worker.js', location.href));
let hooks: { refresh(method: string): void; shown(): void } | undefined;
const models = new Map<string, Monaco>();
const ws = new WebWorkspace(lsp, files, {
    get: rel => { const model = models.get(rel); return model && { text: model.getValue(), version: model.getVersionId() }; },
    open: rel => void addModel(rel, files.read(rel) ?? ''),
    replace: setBuffer
}, log, m => toast(m, 'warning'));
const server = createCanvasServer(ws);
/** The view IRI of a file: a view file of the last refresh (viewFilesOf over turtle/query); undefined for another file. */
const viewIriOf = (rel: string) => ws.viewOfFile(pathOf(rel));
const isView = (rel: string) => viewIriOf(rel) !== undefined;

lsp.on('diagnostics', (uri, list) => {
    ws.setDiagnostics(uri, list);
    const rel = relOfUri(uri), model = rel === undefined ? undefined : models.get(rel);
    if (model) monaco.editor.setModelMarkers(model, 'turtle-lsp', markers(monaco, list));
    renderFiles();
    renderStatus();
});
lsp.on('serverRequest', method => hooks?.refresh(method));
lsp.on('busy', busy => { document.body.dataset.busy = String(busy); renderStatus(); });
lsp.on('crash', message => toast(`turtle-lsp: ${message}`, 'warning'));
// A changed view file draws the canvases again; any other change reads the model again.
files.onDidChange(e => { if (e.kind === 'change' && isView(e.rel)) ws.viewChanged(); else ws.schedule(); renderFiles(); });
ws.onDidChange(() => { renderStatus(); renderFiles(); renderTabs(); });

/** Monaco's AMD loader comes after the bundle ran: a global `define` before it would let UMD modules of the bundle register with it. */
async function loadMonaco(): Promise<Monaco> {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorkerUrl: () => new URL('vendor/monaco/vs/base/worker/workerMain.js', location.href).href };
    await new Promise((ok, err) => {
        const script = document.createElement('script');
        script.src = 'vendor/monaco/vs/loader.js';
        script.onload = ok;
        script.onerror = () => err(new Error('vendor/monaco/vs/loader.js did not load'));
        document.head.append(script);
    });
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    return new Promise((ok, err) => require(['vs/editor/editor.main'], ok, err));
}

const toLsp = (r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): LspRange =>
    ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });

/** The buffer of a file: a Monaco model that turtle-lsp tracks (didOpen, didChange). */
function addModel(rel: string, text: string): Monaco {
    const model = monaco.editor.createModel(text, languageOf(rel), monaco.Uri.parse(uriOf(rel)));
    const uri = model.uri.toString();
    model.onDidChangeContent((e: { changes: { range: Parameters<typeof toLsp>[0]; text: string }[] }) => {
        lsp.notify('textDocument/didChange', { textDocument: { uri, version: model.getVersionId() }, contentChanges: e.changes.map(c => ({ range: toLsp(c.range), text: c.text })) });
        if (isView(rel)) ws.viewChanged();
        renderTabs();
        renderFiles();
    });
    lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageOf(rel), version: model.getVersionId(), text: model.getValue() } });
    models.set(rel, model);
    return model;
}

function removeModel(rel: string): void {
    const model = models.get(rel);
    if (!model) return;
    lsp.notify('textDocument/didClose', { textDocument: { uri: model.uri.toString() } });
    ws.diagnostics.delete(model.uri.toString());
    model.dispose();
    models.delete(rel);
}

/** Replace the buffer text with one undoable edit of its own (didChange follows): the stack elements keep two edits apart. */
function setBuffer(rel: string, text: string): void {
    const model = models.get(rel) ?? addModel(rel, text);
    if (model.getValue() === text) return;
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Tabs: text editors and canvases

/** A view open in a canvas: its iframe. A canvas command edits the buffer of the view file and writes the file (WebWorkspace.applyEdits). */
interface ViewDoc {
    rel: string;
    iri: string;
    frame: HTMLIFrameElement;
    host?: MessagePort;
    stop?: () => void;
}

type Tab = { rel: string; kind: 'text'; state?: unknown } | { rel: string; kind: 'canvas'; doc: ViewDoc };
const tabs: Tab[] = [];
let active: Tab | undefined;
let canvasCount = 0;

const dirtyText = (rel: string) => models.has(rel) && models.get(rel).getValue() !== files.read(rel);
const isDirty = (tab: Tab) => files.unstored.has(tab.rel) || dirtyText(tab.rel);

function renderTabs(): void {
    $('tabs').replaceChildren(...tabs.map(tab => {
        const el = document.createElement('div');
        el.className = 'tab' + (tab === active ? ' active' : '') + (isDirty(tab) ? ' dirty' : '');
        el.title = tab.rel + (tab.kind === 'canvas' ? ' (canvas)' : '');
        el.innerHTML = `<span class="codicon codicon-${tab.kind === 'canvas' ? 'type-hierarchy' : 'file'}"></span><span class="name"></span><button class="close codicon codicon-close" title="Close"></button>`;
        el.querySelector('.name')!.textContent = tab.rel.split('/').pop()!;
        el.onclick = () => activate(tab);
        el.querySelector<HTMLButtonElement>('.close')!.onclick = e => { e.stopPropagation(); closeTab(tab); };
        el.onauxclick = e => { if (e.button === 1) closeTab(tab); };
        return el;
    }));
    const text = active?.kind === 'text';
    $('text-pane').hidden = !text;
    $('empty').hidden = !!active;
    $('open-canvas').hidden = !(text && isView(active!.rel));
    for (const t of tabs) if (t.kind === 'canvas') t.doc.frame.hidden = t !== active;
}

function activate(tab: Tab): void {
    if (active?.kind === 'text') active.state = editor.saveViewState();
    active = tab;
    if (tab.kind === 'text') {
        editor.setModel(models.get(tab.rel) ?? addModel(tab.rel, files.read(tab.rel) ?? ''));
        if (tab.state) editor.restoreViewState(tab.state);
        hooks?.shown();
        requestAnimationFrame(() => { editor.layout(); editor.focus(); });
    } else tab.doc.frame.contentWindow?.focus();
    renderTabs();
    renderFiles();
}

function closeTab(tab: Tab, force = false): boolean {
    if (!force && tab.kind === 'text' && dirtyText(tab.rel)) {
        if (!confirm(`Discard the changes of ${tab.rel}?`)) return false;
        models.get(tab.rel)!.setValue(files.read(tab.rel) ?? '');
    }
    const i = tabs.indexOf(tab);
    tabs.splice(i, 1);
    if (tab.kind === 'canvas') {
        tab.doc.stop?.();
        tab.doc.frame.remove();
    }
    if (active === tab) {
        active = undefined;
        const next = tabs[Math.min(i, tabs.length - 1)];
        if (next) activate(next);
        else editor.setModel(null);
    }
    renderTabs();
    return true;
}

function openText(rel: string, range?: LspRange): void {
    if (!files.has(rel)) return toast(`${rel} does not exist.`, 'warning');
    let tab = tabs.find(t => t.rel === rel && t.kind === 'text');
    if (!tab) tabs.push(tab = { rel, kind: 'text' });
    activate(tab);
    if (range) {
        const r = new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
        editor.setSelection(r);
        editor.revealRangeInCenter(r);
    }
}

/** A view file in a canvas. `fromText`: the text was just saved; the graph is read again and the view takes the file's statements. */
async function openCanvas(rel: string, fromText = false): Promise<void> {
    const existing = tabs.find(t => t.rel === rel && t.kind === 'canvas');
    if (existing) return activate(existing);
    if (fromText) await ws.refresh(); else await ws.ready();
    if (ws.error) return toast(`${rel}: ${ws.error}`, 'warning');
    const view = await ws.viewOfDocument(pathOf(rel));
    if (!view) {
        toast(`${rel} holds no view graph.`, 'warning');
        return openText(rel);
    }
    if ('problem' in view) return toast(`${rel}: ${view.problem}`, 'warning');
    const iri = view.iri;
    if (ws.viewFiles.get(iri) !== pathOf(rel)) return toast(`${rel} was skipped: invalid or duplicate view file.`, 'warning');
    const frame = document.createElement('iframe');
    frame.className = 'canvas-frame';
    frame.src = 'canvas.html';
    const doc: ViewDoc = { rel, iri, frame };
    const tab: Tab = { rel, kind: 'canvas', doc };
    frame.onload = () => {
        const glsp = new MessageChannel(), host = new MessageChannel();
        doc.stop = server.connect(glsp.port1);
        doc.host = host.port1;
        host.port1.onmessage = ({ data }: MessageEvent<FromCanvas>) => fromCanvas(tab as Tab & { kind: 'canvas' }, data);
        const start: CanvasStartMessage = { type: 'start', clientId: `catenary-view_${canvasCount++}`, view: iriId(iri), preferences };
        frame.contentWindow!.postMessage(start, location.origin, [glsp.port2, host.port2]);
    };
    $('panes').append(frame);
    tabs.push(tab);
    activate(tab);
}

function toCanvas(doc: ViewDoc, message: ToCanvas): void {
    doc.host?.postMessage(message);
}

function save(tab: Tab | undefined = active): void {
    if (!tab) return;
    let stored = true;
    // A canvas command writes its file at once; a canvas tab saves the text buffer, as a text tab.
    const model = models.get(tab.rel);
    if (model) stored = files.write(tab.rel, model.getValue());
    if (!stored) toast('Not stored: the browser storage is full or blocked. The file is kept in memory; use Download to keep it.', 'warning');
    renderTabs();
    renderFiles();
}

function fromCanvas(tab: Tab & { kind: 'canvas' }, m: FromCanvas): void {
    const doc = tab.doc;
    if (m.type === 'key') {
        if (m.key === 'save') save(tab);
        else undoRedo(tab.rel, m.key);
        return;
    }
    if (m.type === 'notify') {
        // VS Code shows a GLSP message as a notification; progress has no display here.
        const a = m.action as { kind: string; message?: string; severity?: string; details?: string };
        if (a.kind === 'message' && a.message && a.severity !== 'NONE') toast(a.message + (a.details ? ` (${a.details})` : ''), a.severity === 'INFO' ? 'info' : 'warning');
        return;
    }
    switch (m.name) {
        case INSERT_ELEMENT: void insertElement(doc); break;
        case OPEN_TEXT: void canvasToText(tab); break;
        case OPEN_IN_EVENT: void openIn(doc, m.detail as { view?: string; file?: string; element?: string; problem?: string }); break;
        case DROP_FILES_EVENT: {
            const { uris, at } = m.detail as { uris: string[]; at: { x: number; y: number } };
            void (async () => { for (const [i, uri] of uris.entries()) await linkFile(doc, uri, { x: at.x + i * 40, y: at.y + i * 40 }); })();
            break;
        }
        case PASTE_RDF_EVENT: {
            const { text, mediaType, at } = m.detail as { text: string; mediaType?: string; at?: { x: number; y: number } };
            void pasteTurtle(ws, doc.iri, text, mediaType, at)
                .then(message => toCanvas(doc, { type: 'action', action: StatusAction.create(message, { severity: 'INFO', timeout: 10000 }) }));
            break;
        }
    }
}

/** Undo or redo in a canvas: the undo history of the view file's buffer; the file is written as a canvas command writes it. */
function undoRedo(rel: string, key: 'undo' | 'redo'): void {
    const model = models.get(rel);
    if (!model) return;
    const before = model.getValue();
    if (key === 'undo') model.undo(); else model.redo();
    if (model.getValue() !== before && !files.write(rel, model.getValue())) toast('Not stored: the browser storage is full or blocked. The file is kept in memory; use Download to keep it.', 'warning');
}

/** The TriG button: save first, then the text replaces the canvas tab (VS Code: Reopen Editor With). */
async function canvasToText(tab: Tab & { kind: 'canvas' }): Promise<void> {
    closeTab(tab, true);
    openText(tab.rel);
}

/** "Open in Canvas" of a view file's text: save first, then the canvas replaces the text tab. */
async function textToCanvas(): Promise<void> {
    const tab = active;
    if (tab?.kind !== 'text' || !isView(tab.rel)) return;
    if (dirtyText(tab.rel)) {
        if (!confirm('Save the text before you open it in the canvas?')) return;
        save(tab);
    }
    closeTab(tab, true);
    await openCanvas(tab.rel, true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Canvas requests (vscode/canvas-editor.ts)

/**
 * One pick and one command (vscode/canvas-editor.ts insertElement): the node shapes of the shapes model and the instances of the model
 * files (instanceLabels), by kind, from turtle/query; link rows pick a file or a view.
 */
async function insertElement(doc: ViewDoc): Promise<void> {
    const ctx = ws.context();
    if (!ctx) return toast(`Insert: ${ws.error ?? 'the model is not read yet.'}`, 'warning');
    const view = (await ws.diagram(iriId(doc.iri), {})).doc.views[iriId(doc.iri)];
    const placed = new Set([...boxes(view, 'card').map(b => b.element), ...boxes(view, 'collection').flatMap(b => b.members)]);
    const [labels, viewLabels] = await Promise.all([instanceLabels(ctx, { vocabulary: true }), viewLabelsOf(ctx.port, ctx.views, ctx.manifest.language, ctx.viewLabels)]);
    const { types } = await factsOf(ctx.port, ctx.modelFiles, inShapesOf(ctx.shapes), labels.keys());
    const items: (PickItem & { id?: string; link?: 'file' | 'view' })[] = [];
    for (const shape of Object.values(ctx.shapes.index.model.nodeShapes)) {
        if (!placed.has(shape.id)) items.push({ id: shape.id, label: shape.label, description: shape.uri, detail: 'shape' });
    }
    for (const [iri, label] of labels) {
        if (placed.has(iriId(iri))) continue;
        const of = types.get(iri) ?? [];
        const kind = of.some(t => t === NS.rdfs + 'Class' || t === NS.owl + 'Class') ? 'class'
            : of.includes(NS.skos + 'Concept') ? 'concept' : of.includes(NS.skos + 'Collection') ? 'collection' : 'instance';
        items.push({ id: iriId(iri), label, description: iri, detail: kind });
    }
    items.sort((a, b) => a.label.localeCompare(b.label));
    const picked = await pick([{ label: 'Link to a file…', link: 'file' as const, action: true }, { label: 'Link to a view…', link: 'view' as const, action: true }, ...items], 'Insert elements from the workspace', true);
    for (const item of picked) {
        if (!item.link) continue;
        let rel: string | undefined;
        if (item.link === 'file') rel = (await pick(files.list().map(f => ({ label: f })), 'Link to a file'))[0]?.label;
        else {
            const choices = [...ws.viewFiles].filter(([iri]) => iri !== doc.iri).map(([iri, file]) => ({
                label: viewLabels[iriId(iri)] || file.split('/').pop()!, description: relOfPath(file), rel: relOfPath(file)
            })).sort((a, b) => a.label.localeCompare(b.label));
            rel = (await pick(choices, 'Link to a view'))[0]?.rel;
        }
        if (rel) await linkFile(doc, uriOf(rel), { x: 300, y: 300 });
    }
    const ids = picked.flatMap(item => item.id ? [item.id] : []);
    if (ids.length) {
        const result = await ws.execute(iriId(doc.iri), { kind: 'addToView', view: iriId(doc.iri), ids, at: { x: 300, y: 300 } });
        if (!result.ok) toast(result.error, 'warning');
    }
}

/** A dropped or picked file becomes one undoable reference at the supplied point. */
async function linkFile(doc: ViewDoc, uri: string, at: { x: number; y: number }): Promise<void> {
    const view = iriId(doc.iri);
    try {
        const rel = relOfUri(uri);
        if (rel === undefined || !files.has(rel)) throw new Error(`${uri} is not a workspace file.`);
        let result;
        const target = viewIriOf(rel);
        if (target) {
            if (target === doc.iri) throw new Error('The target view is the open view itself.');
            result = await ws.execute(view, { kind: 'addViewReference', view, target: iriId(target), at });
        } else {
            const from = doc.rel.split('/').slice(0, -1), to = rel.split('/');
            let common = 0;
            while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
            const relative = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
            result = await ws.execute(view, { kind: 'addFileReference', view, file: relative, at });
        }
        if (!result.ok) throw new Error(result.error);
    } catch (e) {
        toast(`Cannot link file: ${e instanceof Error ? e.message : String(e)}`, 'warning');
    }
}

/** Navigate from a reference or a model element to its editor. */
async function openIn(doc: ViewDoc, request: { view?: string; file?: string; element?: string; problem?: string }): Promise<void> {
    try {
        if (request.problem) {
            const properties = ws.shapes?.index.model.nodeShapes[request.problem]?.properties ?? [];
            const problems = ws.violations.filter(v => v.instance === request.problem || iriId(toEngine(v.focus)) === request.problem
                || (v.shape !== undefined && properties.includes(v.shape)));
            if (!problems.length) throw new Error('No problem was found for this element.');
            const problem = problems.length === 1 ? problems[0] : (await pick(problems.map(violation => ({ label: violation.message, violation })), 'Show the problem'))[0]?.violation;
            if (!problem) return;
            const rel = relOfUri(problem.uri);
            if (rel === undefined) throw new Error(`${problem.uri} is not a workspace file.`);
            openText(rel, problem.range);
        } else if (request.view) {
            const iri = idIri(request.view), file = iri ? ws.viewFiles.get(iri) : undefined, rel = file ? relOfPath(file) : undefined;
            if (!rel) throw new Error('The target view file was not found.');
            await openCanvas(rel);
        } else if (request.file) {
            const parts = [...doc.rel.split('/').slice(0, -1)];
            for (const p of request.file.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
            openText(parts.join('/'));
        } else if (request.element) {
            const node = ws.result?.nodes.find(n => !n.literal && iriId(toEngine(n.id)) === request.element && relOfUri(n.uri) !== undefined);
            if (!node) throw new Error('The source of the element was not found.');
            openText(relOfUri(node.uri)!, node.range);
        } else throw new Error('No view, file or element was supplied.');
    } catch (e) {
        toast(`Cannot open in the editor: ${e instanceof Error ? e.message : String(e)}`, 'warning');
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// File list, status and commands

function renderFiles(): void {
    const errors = (rel: string) => (ws.diagnostics.get(uriOf(rel)) ?? []).filter(d => (d.severity ?? 1) <= 2).length;
    $('files').replaceChildren(...files.list().map(rel => {
        const el = document.createElement('div');
        const view = isView(rel);
        el.className = 'file' + (active?.rel === rel ? ' active' : '') + (files.unstored.has(rel) || dirtyText(rel) || tabs.some(t => t.rel === rel && isDirty(t)) ? ' dirty' : '');
        el.draggable = true;
        el.style.paddingLeft = `${8 + 12 * (rel.split('/').length - 1)}px`;
        el.innerHTML = `<span class="codicon codicon-${view ? 'type-hierarchy' : 'file'}"></span><span class="name"></span><span class="count"></span><button class="delete codicon codicon-trash" title="Delete"></button>`;
        el.querySelector('.name')!.textContent = rel;
        const n = errors(rel);
        el.querySelector('.count')!.textContent = n ? String(n) : '';
        el.onclick = () => void (view ? openCanvas(rel) : openText(rel));
        el.ondragstart = e => { e.dataTransfer!.setData('text/uri-list', uriOf(rel)); e.dataTransfer!.effectAllowed = 'copy'; };
        el.querySelector<HTMLButtonElement>('.delete')!.onclick = e => { e.stopPropagation(); deleteFile(rel); };
        return el;
    }));
}

function renderStatus(): void {
    const all = [...ws.diagnostics.values()].flat();
    const count = (s: number) => all.filter(d => (d.severity ?? 1) === s).length;
    const graph = ws.result ? `${ws.result.edges.length} statements` : ws.error ? `graph: ${ws.error}` : 'reading the workspace…';
    $('status').textContent = `turtle-lsp ${document.body.dataset.busy === 'true' ? '⏳' : '✓'} · ${count(1)} errors · ${count(2)} warnings · ${graph}`;
}

function deleteFile(rel: string): void {
    if (!confirm(`Delete ${rel}?`)) return;
    for (const tab of tabs.filter(t => t.rel === rel)) closeTab(tab, true);
    files.delete(rel);
    removeModel(rel);
}

function newFile(): void {
    const rel = ask('File path (for example model.ttl or a.trig):');
    if (!rel) return;
    if (files.has(rel)) return openText(rel);
    files.write(rel, '');
    addModel(rel, '');
    openText(rel);
}

async function newView(): Promise<void> {
    const name = ask('Name of the new view:');
    if (!name) return;
    const dir = files.list().some(f => f.startsWith('views/')) ? 'views/' : '';
    const rel = dir + viewFileName(name);
    if (files.has(rel)) return toast(`${rel} exists.`, 'warning');
    const text = newViewText(name);
    files.write(rel, text);
    addModel(rel, text);
    await ws.refresh();
    await openCanvas(rel);
}

function download(): void {
    const blob = zip(files.list().map(rel => ({ name: rel, text: files.read(rel)! })));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'catenary-workspace.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function resetSamples(): void {
    if (!confirm('Replace all files with the samples? Your changes are lost.')) return;
    for (const tab of [...tabs]) closeTab(tab, true);
    for (const rel of [...models.keys()]) removeModel(rel);
    files.reset();
    for (const rel of files.list()) addModel(rel, files.read(rel)!);
    void ws.refresh();
}

async function main(): Promise<void> {
    renderStatus();
    monaco = await loadMonaco();
    registerSyntax(monaco);
    const dark = matchMedia('(prefers-color-scheme: dark)');
    monaco.editor.setTheme(dark.matches ? 'vs-dark' : 'vs');
    dark.addEventListener('change', () => monaco.editor.setTheme(dark.matches ? 'vs-dark' : 'vs'));
    editor = monaco.editor.create($('monaco'), { model: null, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, 'semanticHighlighting.enabled': true });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    const init = await lsp.initialize({
        processId: null, rootUri: null,
        // turtle/query can only lower query.maxRows (default 1000): Catenary reads every row of a view in one answer.
        initializationOptions: { query: { maxRows: 5000 } },
        capabilities: {
            textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, rename: { prepareSupport: true }, publishDiagnostics: { relatedInformation: true } },
            workspace: { inlayHint: { refreshSupport: true }, semanticTokens: { refreshSupport: true } }
        }
    });
    hooks = connect(monaco, lsp, init.capabilities, uri => ws.diagnostics.get(uri) ?? []);
    for (const rel of files.list()) addModel(rel, files.read(rel)!);
    $('new-file').onclick = newFile;
    $('new-view').onclick = () => void newView();
    $('download').onclick = download;
    $('reset').onclick = resetSamples;
    $('open-canvas').onclick = () => void textToCanvas();
    renderFiles();
    renderTabs();
    await ws.ready();
    const first = new URLSearchParams(location.search).get('open') ?? files.list().find(isView);
    if (first && files.has(first)) await (isView(first) ? openCanvas(first) : openText(first));
    document.body.dataset.ready = 'true';
}

window.addEventListener('beforeunload', e => { if (files.unstored.size > 0 || tabs.some(isDirty) || [...models.keys()].some(dirtyText)) e.preventDefault(); });
void main().catch(e => { toast(`Catenary did not start: ${e instanceof Error ? e.message : String(e)}`, 'warning'); console.error(e); });
