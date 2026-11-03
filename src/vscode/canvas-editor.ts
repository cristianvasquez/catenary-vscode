// Custom text editor of a view file with GLSP transport, settings, navigation and drops; adapted from catenary-vscode src/vscode/canvas-editor.ts.
// The document is the TriG text: a canvas command is one text edit of it, and VS Code owns undo, redo, dirty state, save, revert and backup.

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GlspVscodeConnector, WebviewEndpoint } from '@eclipse-glsp/vscode-integration';
import type { GlspVscodeServer } from '@eclipse-glsp/vscode-integration';
import { DIAGRAM_TYPE } from '../common/protocol';
import { EXPORT_META } from '../common/markdown-export';
import { createCanvasServer } from '../node/glsp/server';
import type { WorkspaceModel } from '../node/workspace-model';
import { idIri, iriId } from '../catenary/model/ids';
import { boxes } from '../catenary/model/doc';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { toEngine } from '../model/graph-input';
import { rdf } from '../catenary/rdf/terms';
import { isInstance, labelLiterals } from '../catenary/rdf/vocabulary';
import { pickLabel } from '../catenary/model/labels';
import { NS } from '../catenary/model/terms';
import { CANVAS_START, type CanvasStart, Preferences, InsertElement, OpenText } from '../webview/messages';
import type { PreferenceValues } from '../webview/preferences';
import { PasteRdf, OpenIn, DropFiles } from '../webview/messages';
import { StatusAction } from '@eclipse-glsp/protocol';
import { pasteTurtle } from './paste-rdf';

export const CANVAS_EDITOR = 'catenary.view';
/** The settings that the canvas reads. */
const CANVAS_SETTINGS = ['cardFontSize', 'groupFontSize', 'noteFontSize', 'edgeStyle', 'vocabularyColor'];

function preferences(): PreferenceValues {
    const config = vscode.workspace.getConfiguration('catenary');
    return Object.fromEntries(CANVAS_SETTINGS.map(name => [`catenary.${name}`, config.get(name)]));
}

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A view document in a canvas: the text document, its folder and its view IRI; `problem` when it holds no view of a folder. The GLSP
 * connector keys its clients on this object (a CustomDocument); the text document is VS Code's.
 */
export class ViewDocument implements vscode.CustomDocument {
    constructor(readonly text: vscode.TextDocument, readonly model?: WorkspaceModel, readonly iri?: string, readonly problem?: string) {}

    get uri(): vscode.Uri { return this.text.uri; }

    dispose(): void { /* VS Code owns the text document */ }
}

export class CanvasEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
    /** The connector to the GLSP server of each folder. */
    protected readonly folders = new Map<WorkspaceModel, GlspVscodeConnector>();
    protected count = 0;
    protected readonly panels = new Map<vscode.WebviewPanel, ViewDocument>();

    /** The canvas and the text editor show the same document: the switch needs no save. */
    protected async openText(document: ViewDocument): Promise<void> {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (!(tab?.input instanceof vscode.TabInputCustom) || tab.input.viewType !== CANVAS_EDITOR
            || tab.input.uri.toString() !== document.uri.toString()) return;
        await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
    }

    /** "Open in Canvas" of a view file's text: the canvas replaces the text tab, on the same document (unsaved text included). */
    async openCanvas(): Promise<void> {
        const group = vscode.window.tabGroups.activeTabGroup, tab = group.activeTab;
        if (!(tab?.input instanceof vscode.TabInputText)) return;
        const uri = tab.input.uri, model = this.modelOf(uri);
        if (!model) return;
        await model.ready();
        if (!await model.viewOfDocument(uri.fsPath)) return;
        const index = group.tabs.indexOf(tab);
        await vscode.commands.executeCommand('vscode.openWith', uri, CANVAS_EDITOR, { viewColumn: group.viewColumn, preview: false });
        if (group.tabs.includes(tab)) await vscode.window.tabGroups.close(tab);
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
    }

    /** One quick pick, one store command and one VS Code undo step. No canvas position supplied: fixed point (300, 300). */
    async insertElement(): Promise<void> {
        const entry = [...this.panels].find(([panel]) => panel.active);
        if (!entry) return;
        const [, document] = entry, model = document.model, open = document.iri ? { iri: document.iri } : undefined;
        if (!model?.graph || !open) return;
        const graph = model.graph, seen = new Set<string>();
        const view = (await model.diagram(iriId(open.iri), {})).doc.views[iriId(open.iri)];
        const placed = new Set([...boxes(view, 'card').map(b => b.element), ...boxes(view, 'collection').flatMap(b => b.members)]);
        const items: (vscode.QuickPickItem & { id: string })[] = [];
        for (const node of model.result?.nodes ?? []) {
            if (node.literal || seen.has(node.id) || vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(node.uri)) !== model.folder) continue;
            seen.add(node.id);
            const iri = toEngine(node.id), term = rdf.namedNode(iri);
            if (placed.has(iriId(iri))) continue;
            const types = graph.match(term, rdf.namedNode(NS.rdf + 'type'), null).map(q => q.object.value);
            const kind = types.includes(NS.sh + 'NodeShape') ? 'shape' : types.some(t => t === NS.rdfs + 'Class' || t === NS.owl + 'Class') ? 'class'
                : types.includes(NS.skos + 'Concept') ? 'concept' : types.includes(NS.skos + 'Collection') ? 'collection' : isInstance(graph, term) ? 'instance' : undefined;
            if (kind) items.push({ id: iriId(iri), label: node.label || node.name || iri, description: iri, detail: kind });
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
                    label: pickLabel(labelLiterals(predicate => predicate === NS.rdfs + 'label'
                        ? graph.match(rdf.namedNode(iri), rdf.namedNode(predicate), null, rdf.namedNode(iri)).map(q => q.object) : []), graph.language) || path.basename(file),
                    description: path.relative(model.folder.uri.fsPath, file), file
                })).sort((a, b) => a.label.localeCompare(b.label));
                const target = await vscode.window.showQuickPick(choices, { placeHolder: 'Link to a view', matchOnDescription: true });
                if (target) resource = vscode.Uri.file(target.file);
            }
            if (!this.panels.has(entry[0])) return;
            if (resource) await this.linkFile(document, resource.toString(), { x: 300, y: 300 });
        }
        const ids = picked.flatMap(item => 'id' in item ? [item.id] : []);
        if (ids.length) {
            const result = await model.execute(iriId(open.iri), { kind: 'addToView', view: iriId(open.iri), ids, at: { x: 300, y: 300 } });
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

    /** Each dropped file is one undoable reference; subsequent references are offset. Commands run one after the other. */
    protected async dropFiles(document: ViewDocument, request: { uris: string[]; at: { x: number; y: number } }): Promise<void> {
        for (const [i, uri] of request.uris.entries()) await this.linkFile(document, uri, { x: request.at.x + i * 40, y: request.at.y + i * 40 });
    }

    /** A dropped or picked file becomes one undoable reference at the supplied point: a view file of the folder a view reference. */
    protected async linkFile(document: ViewDocument, uri: string, at: { x: number; y: number }): Promise<void> {
        const model = document.model, iri = document.iri;
        if (!model || !iri) return;
        const view = iriId(iri);
        try {
            const resource = vscode.Uri.parse(uri);
            if (resource.scheme !== 'file') throw new Error('Only file URIs can be linked.');
            const file = resource.fsPath, target = model.viewOfFile(file);
            if (target === iri) throw new Error('The target view is the open view itself.');
            const result = target
                ? await model.execute(view, { kind: 'addViewReference', view, target: iriId(target), at })
                : await model.execute(view, { kind: 'addFileReference', view, file: path.relative(path.dirname(document.uri.fsPath), file).split(path.sep).join('/'), at });
            if (!result.ok) throw new Error(result.error);
        } catch (e) {
            void vscode.window.showWarningMessage(`Cannot link file: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    constructor(protected readonly extensionUri: vscode.Uri,
        protected readonly modelOf: (uri: vscode.Uri) => WorkspaceModel | undefined,
        protected readonly log: (line: string) => void) {}

    /**
     * The view of a text document: its view IRI as the server reads the document now (the open buffer), checked against the view files of
     * its folder; the folder is read again when they do not have it (a view written in the text and not saved, a view IRI changed in the
     * text). Undefined: the document holds no view:View (a model file).
     */
    async viewDocumentOf(text: vscode.TextDocument): Promise<ViewDocument | undefined> {
        const file = text.uri.fsPath, model = this.modelOf(text.uri);
        if (!model) return new ViewDocument(text, undefined, undefined, `${file} is not in a workspace folder.`);
        await model.ready();
        const found = await model.viewOfDocument(file);
        if (!found) return undefined;
        if ('problem' in found) return new ViewDocument(text, model, undefined, `${file}: ${found.problem}`);
        if (model.viewFiles.get(found.iri) !== file) await model.refresh();
        if (model.viewFiles.get(found.iri) !== file) return new ViewDocument(text, model, undefined, `${file} was skipped: invalid or duplicate view file. See the Catenary output.`);
        return new ViewDocument(text, model, found.iri);
    }

    async resolveCustomTextEditor(text: vscode.TextDocument, panel: vscode.WebviewPanel, _token?: vscode.CancellationToken, exportToken?: string): Promise<void> {
        const file = text.uri.fsPath, document = await this.viewDocumentOf(text);
        if (!document) {
            if (exportToken) throw new Error(`${file} holds no view.`);
            // A .trig file without a view:View is a model file: the text editor opens it.
            panel.dispose();
            await vscode.commands.executeCommand('vscode.openWith', text.uri, 'default');
            return;
        }
        const model = document.model, iri = document.iri;
        if (!model || !iri) {
            panel.webview.html = `<!doctype html><html><body><p>${escapeAttribute(document.problem ?? `${file} holds no view.`)}</p></body></html>`;
            this.log(`canvas: no view for ${file}: ${document.problem}`);
            if (exportToken) throw new Error(document.problem ?? `${file} holds no view.`);
            return;
        }
        this.panels.set(panel, document);
        panel.onDidDispose(() => this.panels.delete(panel));
        const view = iriId(iri);
        const connector = await this.connectorOf(model);
        const clientId = `${DIAGRAM_TYPE}_${this.count++}`;
        const endpoint = new WebviewEndpoint({ diagramIdentifier: { diagramType: DIAGRAM_TYPE, uri: document.uri.toString(), clientId }, messenger: connector.messenger, webviewPanel: panel });
        const sender = endpoint.messageParticipant;
        connector.messenger.onNotification(InsertElement, () => this.insertElement(), { sender });
        connector.messenger.onNotification(OpenText, () => this.openText(document), { sender });
        connector.messenger.onNotification(OpenIn, request => void this.openIn(document, request), { sender });
        connector.messenger.onNotification(DropFiles, request => void this.dropFiles(document, request), { sender });
        connector.messenger.onNotification(PasteRdf, ({ text, mediaType, at }) => void pasteTurtle(model, iri, text, mediaType, at)
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
        for (const connector of this.folders.values()) connector.dispose();
        this.folders.clear();
    }
}
