// Activation: one workspace graph per workspace folder (node/workspace-model.ts) and the custom editor of view files.
import * as vscode from 'vscode';
import { WorkspaceModel } from './node/workspace-model';
import type { TurtleApi } from './node/turtle-api';
import { CANVAS_EDITOR, CanvasEditorProvider } from './vscode/canvas-editor';
import { exportMarkdown, insertView } from './vscode/markdown-commands';
import { MarkdownSvgRenderer } from './vscode/markdown-svg';
import { newView } from './vscode/new-view';

const TURTLE_EXTENSION = 'abhishekkundu25.turtle-language-server';
let shown = false;

/** The turtle-lsp API, read when used: `idle()` first activates the extension. */
function turtleApi(log: (line: string) => void): TurtleApi {
    const ext = () => {
        const found = vscode.extensions.getExtension<TurtleApi>(TURTLE_EXTENSION);
        if (!found) {
            const message = `${TURTLE_EXTENSION} is not installed`;
            log(message);
            if (!shown) {
                shown = true;
                void vscode.window.showErrorMessage('Catenary needs the Turtle RDF language server (abhishekkundu25.turtle-language-server).', 'Install').then(async choice => {
                    if (choice !== 'Install') return;
                    try {
                        await vscode.commands.executeCommand('workbench.extensions.installExtension', TURTLE_EXTENSION);
                    } catch {
                        await vscode.env.openExternal(vscode.Uri.parse('https://github.com/abhishekkundu25/turtle-lsp/releases'));
                    }
                }).then(undefined, error => log(String(error)));
            }
            throw new Error(message);
        }
        return found;
    };
    return {
        client: () => ext().exports?.client(),
        idle: async () => (await ext().activate()).idle()
    };
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Catenary');
    const log = (line: string) => output.appendLine(line);
    const api = turtleApi(log);
    const models = new Map<string, WorkspaceModel>();
    const modelOf = (uri: vscode.Uri) => {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return undefined;
        const key = folder.uri.toString();
        return models.get(key) ?? models.set(key, new WorkspaceModel(folder, () => api, log)).get(key)!;
    };
    const canvas = new CanvasEditorProvider(context.extensionUri, modelOf, log);
    context.subscriptions.push(output, canvas, { dispose: () => { for (const m of models.values()) m.dispose(); } },
        vscode.window.registerCustomEditorProvider(CANVAS_EDITOR, canvas, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
    const markdownSvg = new MarkdownSvgRenderer(canvas, modelOf);
    context.subscriptions.push(
        vscode.commands.registerCommand('catenary.insertElement', () => canvas.insertElement()),
        vscode.commands.registerCommand('catenary.openCanvas', () => canvas.openCanvas()),
        vscode.commands.registerCommand('catenary.insertView', insertView),
        vscode.commands.registerCommand('catenary.newView', (uri?: vscode.Uri, _uris?: unknown, answer?: string) => newView(modelOf, uri, answer)),
        vscode.commands.registerCommand('catenary.exportMarkdown', (uri, uris, answer) => exportMarkdown(uri, uris, answer, entry => markdownSvg.svgOf(entry))));
}

export function deactivate(): void { /* the subscriptions dispose */ }
