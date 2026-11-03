// Custom view-file editor with GLSP transport, settings, navigation and drops; adapted from catenary-vscode src/vscode/canvas-editor.ts.
// ViewStore steps map to VS Code undo history; view files are written on save only.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GlspVscodeConnector, WebviewEndpoint } from '@eclipse-glsp/vscode-integration';
import type { GlspVscodeServer } from '@eclipse-glsp/vscode-integration';
import { DIAGRAM_TYPE } from '../common/protocol';
import { EXPORT_META } from '../common/markdown-export';
import { createCanvasServer } from '../node/glsp/server';
import { type OpenView, type WorkspaceModel, viewIriOfFile } from '../node/workspace-model';
import { idIri, iriId } from '../catenary/model/ids';
import { boxes } from '../catenary/model/doc';
import { readView } from '../catenary/rdf/view-read';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { isViewFile, toEngine } from '../model/graph-input';
import { NS } from '../catenary/model/terms';
import { CANVAS_START, type CanvasStart, Preferences, InsertElement, OpenText } from '../webview/messages';
import type { PreferenceValues } from '../webview/preferences';
import { PasteRdf, OpenIn, DropFiles } from '../webview/messages';
import { StatusAction } from '@eclipse-glsp/protocol';
import { pasteTurtle } from './paste-rdf';
import { instanceLabels } from '../read/choices';
import { factsOf, inShapesOf } from '../read/neighbors';
import { viewLabelsOf } from '../read/view';

export const CANVAS_EDITOR = 'catenary.view';
/** The settings that the canvas reads. */
const CANVAS_SETTINGS = ['cardFontSize', 'groupFontSize', 'noteFontSize', 'edgeStyle', 'vocabularyColor'];

function preferences(): PreferenceValues {
    const config = vscode.workspace.getConfiguration('catenary');
    return Object.fromEntries(CANVAS_SETTINGS.map(name => [`catenary.${name}`, config.get(name)]));
}

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** The text of a file; undefined when it cannot be read. */
const readText = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };

/** A view file open in the editor. `open`: its store on the workspace graph; undefined when the file holds no view of a folder. */
export class ViewDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri, readonly model?: WorkspaceModel, public open?: OpenView & vscode.Disposable, readonly problem?: string) {}

    /** The workspace graph takes the view from its file again: a document closed without saving leaves no edit in the graph. */
    dispose(): void {
        this.open?.dispose();
        this.open = undefined;
    }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export class CanvasEditorProvider implements vscode.CustomEditorProvider<ViewDocument>, vscode.Disposable {
    /** The connector to the GLSP server of each folder. */
    protected readonly folders = new Map<WorkspaceModel, GlspVscodeConnector>();
    protected count = 0;
    protected readonly panels = new Map<vscode.WebviewPanel, ViewDocument>();
    protected readonly fromText = new Set<string>();

    /** Switching editors is disk-based: save before replacing the active tab. */
    protected async saveBeforeSwitch(tab: vscode.Tab, message: string): Promise<boolean> {
        if (tab.isDirty) {
            if (await vscode.window.showWarningMessage(message, { modal: true }, 'Save') !== 'Save') return false;
            if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return false;
            await vscode.commands.executeCommand('workbench.action.files.save');
        }
        return vscode.window.tabGroups.activeTabGroup.activeTab === tab && !tab.isDirty;
    }

    protected async openText(document: ViewDocument): Promise<void> {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (!(tab?.input instanceof vscode.TabInputCustom) || tab.input.viewType !== CANVAS_EDITOR
            || tab.input.uri.toString() !== document.uri.toString()) return;
        if (await this.saveBeforeSwitch(tab, 'Save the view before you open it as TriG.')) {
            await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
        }
    }

    async openCanvas(): Promise<void> {
        const group = vscode.window.tabGroups.activeTabGroup, tab = group.activeTab;
        if (!(tab?.input instanceof vscode.TabInputText) || !isViewFile(tab.input.uri.path, tab.input.uri.scheme === 'file' ? readText(tab.input.uri.fsPath) : undefined)) return;
        if (!await this.saveBeforeSwitch(tab, 'Save the text before you open it in Canvas.')) return;
        const index = group.tabs.indexOf(tab);
        const uri = tab.input.uri;
        this.fromText.add(uri.toString());
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, CANVAS_EDITOR, { viewColumn: group.viewColumn, preview: false });
        } finally {
            this.fromText.delete(uri.toString());
        }
        if (group.tabs.includes(tab)) await vscode.window.tabGroups.close(tab);
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
    }

    /**
     * One quick pick, one store command and one VS Code undo step. No canvas position supplied: fixed point (300, 300). The candidates come
     * from turtle/query: the node shapes of the shapes model and the instances of the model files with the SKOS subjects of the shapes (instanceLabels), by kind.
     */
    async insertElement(): Promise<void> {
        const entry = [...this.panels].find(([panel]) => panel.active);
        if (!entry) return;
        const [, document] = entry, model = document.model, open = document.open, ctx = model?.context();
        if (!model || !ctx || !open) return;
        const view = readView(open.store.graph, iriId(open.iri)).views[iriId(open.iri)];
        const placed = new Set([...boxes(view, 'card').map(b => b.element), ...boxes(view, 'collection').flatMap(b => b.members)]);
        const [labels, viewLabels] = await Promise.all([instanceLabels(ctx, { vocabulary: true }), viewLabelsOf(ctx.port, ctx.modelFiles, ctx.manifest.language)]);
        const { types } = await factsOf(ctx.port, ctx.modelFiles, inShapesOf(ctx.shapes), labels.keys());
        const items: (vscode.QuickPickItem & { id: string })[] = [];
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
        const links: (vscode.QuickPickItem & { link: 'file' | 'view' })[] = [
            { label: 'Link to a file…', link: 'file' }, { label: 'Link to a view…', link: 'view' }
        ];
        // A link row acts at once: its selection hides the pick, so that its check box never stays ticked.
        const quickPick = vscode.window.createQuickPick<(typeof links)[number] | (typeof items)[number]>();
        quickPick.canSelectMany = true;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.placeholder = 'Insert elements from the workspace';
        quickPick.items = [...links, ...items.sort((a, b) => a.label.localeCompare(b.label))];
        const picked = await new Promise<readonly (typeof quickPick.items)[number][]>(resolve => {
            let result: readonly (typeof quickPick.items)[number][] = [];
            quickPick.onDidChangeSelection(selection => {
                if (selection.some(item => 'link' in item)) { result = selection; quickPick.hide(); }
            });
            quickPick.onDidAccept(() => { result = quickPick.selectedItems; quickPick.hide(); });
            quickPick.onDidHide(() => { quickPick.dispose(); resolve(result); });
            quickPick.show();
        });
        if (!picked?.length || !this.panels.has(entry[0])) return;
        for (const item of picked) {
            if (!('link' in item)) continue;
            let resource: vscode.Uri | undefined;
            if (item.link === 'file') {
                resource = (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, defaultUri: model.folder.uri }))?.[0];
            } else {
                const choices = [...model.viewFiles].filter(([iri]) => iri !== open.iri).map(([iri, file]) => ({
                    label: viewLabels[iriId(iri)] || path.basename(file),
                    description: path.relative(model.folder.uri.fsPath, file), file
                })).sort((a, b) => a.label.localeCompare(b.label));
                const target = await vscode.window.showQuickPick(choices, { placeHolder: 'Link to a view', matchOnDescription: true });
                if (target) resource = vscode.Uri.file(target.file);
            }
            if (!this.panels.has(entry[0]) || document.open !== open) return;
            if (resource) this.linkFile(document, resource.toString(), { x: 300, y: 300 });
        }
        const ids = picked.flatMap(item => 'id' in item ? [item.id] : []);
        if (ids.length) {
            const result = model.execute(iriId(open.iri), { kind: 'addToView', view: iriId(open.iri), ids, at: { x: 300, y: 300 } });
            if (!result.ok) void vscode.window.showWarningMessage(result.error);
        }
    }
    /** Navigate from a reference or a model element to its editor. */
    protected async openIn(document: ViewDocument, request: { view?: string; file?: string; element?: string; problem?: string }): Promise<void> {
        const model = document.model;
        try {
            if (request.problem) {
                const properties = model?.graph ? shapesIndexOf(model.graph).model.nodeShapes[request.problem]?.properties ?? [] : [];
                const problems = (model?.violations ?? []).filter(v => v.instance === request.problem || iriId(toEngine(v.focus)) === request.problem
                    || (v.shape !== undefined && properties.includes(v.shape)));
                if (!problems.length) throw new Error('No problem was found for this element.');
                const problem = problems.length === 1 ? problems[0] : (await vscode.window.showQuickPick(
                    problems.map(violation => ({ label: violation.message, violation })), { placeHolder: 'Show the problem' }
                ))?.violation;
                if (!problem) return;
                const range = problem.range;
                await vscode.window.showTextDocument(vscode.Uri.parse(problem.uri), { selection: new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character) });
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            } else if (request.view) {
                const iri = idIri(request.view);
                const file = iri ? model?.viewFiles.get(iri) : undefined;
                if (!file) throw new Error('The target view file was not found.');
                await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), CANVAS_EDITOR);
            } else if (request.file) {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), request.file)));
            } else if (request.element) {
                const node = model?.result?.nodes.find(n => !n.literal && iriId(toEngine(n.id)) === request.element
                    && vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(n.uri)) === model.folder);
                if (!node) throw new Error('The source of the element was not found.');
                const range = node.range;
                await vscode.window.showTextDocument(vscode.Uri.parse(node.uri), { selection: new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character) });
            } else throw new Error('No view, file or element was supplied.');
        } catch (e) {
            void vscode.window.showWarningMessage(`Cannot open in the editor: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Each dropped file is one undoable reference; subsequent references are offset. */
    protected dropFiles(document: ViewDocument, request: { uris: string[]; at: { x: number; y: number } }): void {
        request.uris.forEach((uri, i) => this.linkFile(document, uri, { x: request.at.x + i * 40, y: request.at.y + i * 40 }));
    }

    /** A dropped or picked file becomes one undoable reference at the supplied point. */
    protected linkFile(document: ViewDocument, uri: string, at: { x: number; y: number }): void {
        const model = document.model, open = document.open;
        if (!model || !open) return;
        const view = iriId(open.iri);
        try {
            const resource = vscode.Uri.parse(uri);
            if (resource.scheme !== 'file') throw new Error('Only file URIs can be linked.');
            const file = resource.fsPath;
            let result;
            if (isViewFile(file, readText(file))) {
                const target = viewIriOfFile(file);
                if (!target) throw new Error(`${file} holds no view.`);
                if (target === open.iri) throw new Error('The target view is the open view itself.');
                result = model.execute(view, { kind: 'addViewReference', view, target: iriId(target), at });
            } else {
                result = model.execute(view, { kind: 'addFileReference', view, file: path.relative(path.dirname(document.uri.fsPath), file).split(path.sep).join('/'), at });
            }
            if (!result.ok) throw new Error(result.error);
        } catch (e) {
            void vscode.window.showWarningMessage(`Cannot link file: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    protected readonly changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ViewDocument>>();
    readonly onDidChangeCustomDocument = this.changes.event;

    constructor(protected readonly extensionUri: vscode.Uri,
        protected readonly modelOf: (uri: vscode.Uri) => WorkspaceModel | undefined,
        protected readonly log: (line: string) => void) {}

    /** The store of the view on the workspace graph (after its first read); a backup replaces the view graph with its content. */
    async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext, _token?: vscode.CancellationToken, readOnly = false): Promise<ViewDocument> {
        const file = uri.fsPath, model = this.modelOf(uri);
        if (!model) return new ViewDocument(uri, undefined, undefined, `${file} is not in a workspace folder.`);
        let iri: string | undefined;
        try { iri = viewIriOfFile(file); } catch (e) { return new ViewDocument(uri, model, undefined, `${file}: ${e}`); }
        if (!iri) return new ViewDocument(uri, model, undefined, `${file} holds no view.`);
        const fromText = this.fromText.has(uri.toString());
        if (fromText) await model.refresh();
        else await model.ready();
        if (!model.graph) return new ViewDocument(uri, model, undefined, `${file}: ${model.error ?? 'no workspace graph'}`);
        if (model.viewFiles.get(iri) !== file) return new ViewDocument(uri, model, undefined, `${file} was skipped: invalid or duplicate view file. See the Catenary output.`);
        const document = new ViewDocument(uri, model);
        // No await between replacing the disk graph and opening its store: a pending watcher
        // refresh must preserve this graph through keepOpenViews, not the pre-save graph.
        if (fromText) model.replaceView(iri, readFileSync(file, 'utf8'));
        document.open = this.openView(document, iri, readOnly);
        if (context.backupId) model.replaceView(iri, decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(context.backupId))));
        return document;
    }

    /**
     * One store step of the document is one VS Code step: undo and redo apply the patch of that step to the workspace graph and draw
     * again. A step of a store that a revert replaced does nothing.
     */
    protected openView(document: ViewDocument, iri: string, readOnly = false): OpenView & vscode.Disposable {
        const model = document.model!;
        const open = model.openView(iri, readOnly ? undefined : (label, patch) => this.changes.fire({
            document, label,
            undo: () => { if (document.open === open) { open.store.graph.undo(patch); model.redraw(); } },
            redo: () => { if (document.open === open) { open.store.graph.redo(patch); model.redraw(); } }
        }), () => {
            try { model.replaceView(iri, readFileSync(document.uri.fsPath, 'utf8')); } catch { /* the next refresh drops a deleted file */ }
        });
        return open;
    }

    protected async write(document: ViewDocument, uri: vscode.Uri): Promise<void> {
        if (!document.open) throw new Error(document.problem ?? 'No view.');
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(document.open.store.viewText(document.open.iri)));
    }

    saveCustomDocument(document: ViewDocument): Promise<void> {
        return this.write(document, document.uri);
    }

    saveCustomDocumentAs(document: ViewDocument, destination: vscode.Uri): Promise<void> {
        return this.write(document, destination);
    }

    /** The view graph of the file, and a new store: the steps before the revert change nothing. */
    async revertCustomDocument(document: ViewDocument): Promise<void> {
        const open = document.open;
        if (!open || !document.model) return;
        document.model.replaceView(open.iri, decode(await vscode.workspace.fs.readFile(document.uri)));
        open.dispose();
        document.open = this.openView(document, open.iri);
    }

    async backupCustomDocument(document: ViewDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        await this.write(document, context.destination);
        return { id: context.destination.toString(), delete: () => void vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined) };
    }

    async resolveCustomEditor(document: ViewDocument, panel: vscode.WebviewPanel, _token?: vscode.CancellationToken, exportToken?: string): Promise<void> {
        const file = document.uri.fsPath, model = document.model, open = document.open;
        if (!model || !open) {
            if (!isViewFile(file, readText(file))) {
                // A .trig file without a view:View is a model file: the text editor opens it.
                panel.dispose();
                await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                return;
            }
            panel.webview.html = `<!doctype html><html><body><p>${escapeAttribute(document.problem ?? `${file} holds no view.`)}</p></body></html>`;
            this.log(`canvas: no view for ${file}: ${document.problem}`);
            return;
        }
        this.panels.set(panel, document);
        panel.onDidDispose(() => this.panels.delete(panel));
        const view = iriId(open.iri);
        const connector = await this.connectorOf(model);
        const clientId = `${DIAGRAM_TYPE}_${this.count++}`;
        const endpoint = new WebviewEndpoint({ diagramIdentifier: { diagramType: DIAGRAM_TYPE, uri: document.uri.toString(), clientId }, messenger: connector.messenger, webviewPanel: panel });
        const sender = endpoint.messageParticipant;
        connector.messenger.onNotification(InsertElement, () => this.insertElement(), { sender });
        connector.messenger.onNotification(OpenText, () => this.openText(document), { sender });
        connector.messenger.onNotification(OpenIn, request => void this.openIn(document, request), { sender });
        connector.messenger.onNotification(DropFiles, request => this.dropFiles(document, request), { sender });
        connector.messenger.onNotification(PasteRdf, ({ text, mediaType, at }) => void pasteTurtle(model, document.open?.iri ?? open.iri, text, mediaType, at)
            .then(message => connector.dispatchAction(StatusAction.create(message, { severity: 'INFO', timeout: 10000 }), clientId)), { sender });
        const subscription = vscode.workspace.onDidChangeConfiguration(e => {
            if (CANVAS_SETTINGS.some(name => e.affectsConfiguration(`catenary.${name}`))) connector.messenger.sendNotification(Preferences, sender, preferences());
        });
        panel.onDidDispose(() => subscription.dispose());
        await connector.registerClient({ clientId, diagramType: DIAGRAM_TYPE, document, webviewEndpoint: endpoint });
        this.setHtml(panel, clientId, { view, preferences: preferences() }, exportToken);
        this.log(`canvas ${clientId}: ${file} -> ${view}`);
    }

    /** The connector of a folder, made on its first view editor; the server starts with it. */
    async connectorOf(model: WorkspaceModel): Promise<GlspVscodeConnector> {
        let connector = this.folders.get(model);
        if (connector) return connector;
        const server = createCanvasServer(model);
        connector = new GlspVscodeConnector({ server: server as unknown as GlspVscodeServer });
        this.folders.set(model, connector);
        await server.start();
        await server.onReady;
        return connector;
    }

    protected setHtml(panel: vscode.WebviewPanel, clientId: string, start: CanvasStart, exportToken?: string): void {
        const root = vscode.Uri.joinPath(this.extensionUri, 'dist');
        panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
        const nonce = randomBytes(24).toString('base64');
        const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.js'));
        const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.css'));
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource} 'unsafe-inline'; img-src ${panel.webview.cspSource} data:; font-src ${panel.webview.cspSource};`;
        // The GLSP widget mounts into `<clientId>_container`; the starter gets the client id from the host (WebviewEndpoint).
        panel.webview.html = `<!doctype html><html><head>${exportToken ? `<meta name="${EXPORT_META}" content="${escapeAttribute(exportToken)}">` : ''}<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
            + `<meta name="${CANVAS_START}" content="${escapeAttribute(JSON.stringify(start))}"><link rel="stylesheet" href="${style}"></head>`
            + `<body><div id="${clientId}_container" class="catenary-canvas"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    }

    dispose(): void {
        this.changes.dispose();
        for (const connector of this.folders.values()) connector.dispose();
        this.folders.clear();
    }
}
