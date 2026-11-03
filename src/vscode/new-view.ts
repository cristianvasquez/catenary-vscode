// New View: ask a name, write an empty view file and open it in the canvas editor.
import * as vscode from 'vscode';
import { nameToURI } from 'canonical-md';
import type { WorkspaceModel } from '../node/workspace-model';
import { newViewText, viewFileName } from '../node/new-view';
import { CANVAS_EDITOR } from './canvas-editor';

/** The folder of the new file: the explorer folder (or the folder of the explorer file), else that of the active file, else the first workspace folder. */
async function targetFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const at = uri ?? vscode.window.activeTextEditor?.document.uri ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
    if (at?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(at)) {
        const stat = await vscode.workspace.fs.stat(at).then(s => s, () => undefined);
        return stat?.type === vscode.FileType.Directory ? at : vscode.Uri.joinPath(at, '..');
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** `answer`: the name, without the input box (integration tests). Returns the new file, or undefined when cancelled or refused. */
export async function newView(modelOf: (uri: vscode.Uri) => WorkspaceModel | undefined, uri?: vscode.Uri, answer?: string): Promise<vscode.Uri | undefined> {
    const folder = await targetFolder(uri instanceof vscode.Uri ? uri : undefined);
    if (!folder) return void vscode.window.showErrorMessage('Catenary: open a workspace folder to create a view.');
    const model = modelOf(folder)!;
    await model.ready();
    const name = (answer ?? await vscode.window.showInputBox({
        title: 'Catenary: New View', prompt: `View name (file in ${vscode.workspace.asRelativePath(folder, true)})`,
        validateInput: value => {
            const text = value.trim();
            if (!text) return 'Type a name.';
            if (model.viewFiles.has(nameToURI(text).value)) return `The view "${text}" exists: ${model.viewFiles.get(nameToURI(text).value)}`;
            return undefined;
        }
    }))?.trim();
    if (!name) return;
    const file = vscode.Uri.joinPath(folder, viewFileName(name));
    if (await vscode.workspace.fs.stat(file).then(() => true, () => false)) return void vscode.window.showErrorMessage(`Catenary: ${file.fsPath} exists.`);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(newViewText(name)));
    // The editor opens a view file that the last refresh read: refresh now, not after the watcher delay.
    await model.refresh();
    if (model.viewFiles.get(nameToURI(name).value) !== file.fsPath) throw new Error(`Catenary: ${file.fsPath} is not read as a view. See the Catenary output.`);
    await vscode.commands.executeCommand('vscode.openWith', file, CANVAS_EDITOR);
    return file;
}
