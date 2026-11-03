// A separate, temporary canvas for export. It never opens or changes the user's custom editor.
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { SvgExported, HideExportCanvas } from '../common/markdown-export';
import type { WorkspaceModel } from '../node/workspace-model';
import { CanvasEditorProvider } from './canvas-editor';
import type { ViewEntry } from './markdown-commands';

export class MarkdownSvgRenderer {
    constructor(private readonly canvas: CanvasEditorProvider, private readonly modelOf: (uri: vscode.Uri) => WorkspaceModel | undefined) {}

    async svgOf(entry: ViewEntry): Promise<string> {
        const model = this.modelOf(entry.file);
        if (!model) throw new Error('The view is not in a workspace folder.');
        await model.ready();
        if (model.error) throw new Error(model.error);
        const connector = await this.canvas.connectorOf(model);
        const token = randomUUID();
        const previous = vscode.window.activeTextEditor;
        const panel = vscode.window.createWebviewPanel('catenary.markdownExport', token,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let received: vscode.Disposable | undefined;
        let closed: vscode.Disposable | undefined;
        const hide = connector.messenger.onRequest(HideExportCanvas, async requested => {
            if (requested !== token) return;
            if (previous) await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn, preserveFocus: true });
        });
        try {
            const result = new Promise<string>((resolve, reject) => {
                received = connector.messenger.onNotification(SvgExported, result => {
                    if (result.token !== token) return;
                    if (result.error || !result.svg) reject(new Error(result.error ?? 'Empty SVG.'));
                    else resolve(result.svg);
                });
                closed = panel.onDidDispose(() => reject(new Error('The export canvas was closed.')));
                timer = setTimeout(() => reject(new Error('SVG export timed out after 60 seconds.')), 60_000);
            });
            // Attach a rejection handler while the GLSP client is being registered.
            void result.catch(() => undefined);
            // The text document of the view (the open buffer when an editor has it); the export canvas sends no edit.
            const text = await vscode.workspace.openTextDocument(entry.file);
            await this.canvas.resolveCustomTextEditor(text, panel, undefined, token);
            return await result;
        } finally {
            clearTimeout(timer);
            hide.dispose();
            received?.dispose();
            closed?.dispose();
            panel.dispose();
            if (previous) await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn, preserveFocus: true });
        }
    }
}
