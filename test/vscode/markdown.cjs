// Runs inside the real VS Code extension host, with turtle-lsp and no open canvas editor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
    const fixture = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const destination = process.env.CATENARY_MARKDOWN_OUT;
    const file = path.join(fixture, 'document.md');
    const source = '# Bookshop\n\n![Bookshop model](urn:name:Bookshop%20model)\n';
    fs.writeFileSync(file, source);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const extension = vscode.extensions.getExtension('cvasquezpaulus.catenary');
    assert.ok(extension, 'extension installed');
    await extension.activate();
    assert.equal(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputCustom), false);
    const result = await vscode.commands.executeCommand('catenary.exportMarkdown', document.uri, undefined,
        { documents: ['document.md'], destination });
    assert.ok(result?.ok, JSON.stringify(result));
    const markdown = fs.readFileSync(path.join(destination, 'document.md'), 'utf8');
    const svgs = fs.readdirSync(path.join(destination, '_resources')).filter(f => f.endsWith('.svg'));
    assert.equal(svgs.length, 1);
    assert.ok(markdown.includes(`_resources/${svgs[0]}`), markdown);
    const svg = fs.readFileSync(path.join(destination, '_resources', svgs[0]), 'utf8');
    assert.ok(svg.includes('Shop shape'), 'SVG contains Shop shape');
    assert.ok(!svg.includes('foreignObject'), 'document SVG uses native SVG text');
    assert.equal(fs.readFileSync(file, 'utf8'), source, 'source document unchanged');
    console.log('ok - Markdown export: 1 document, 1 SVG, Shop shape; no visible canvas required');
    const views = vscode.Uri.file(path.join(fixture, 'views'));
    const created = await vscode.commands.executeCommand('catenary.newView', views, undefined, 'Empty view');
    assert.equal(created?.fsPath, path.join(fixture, 'views', 'Empty view.view.trig'));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === 'catenary.view' && tab.input.uri.fsPath === created.fsPath, 'canvas editor open');
    console.log('ok - New View: views/Empty view.view.trig is a view and opens in the canvas editor');
};
