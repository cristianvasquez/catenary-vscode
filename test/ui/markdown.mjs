// A second UI check: real VS Code extension host, GLSP webview and turtle-lsp SVG export.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extensionsDir, prepare, root } from '../vscode/setup.mjs';

const { vscodeExecutablePath, userData, fixture, cleanup } = await prepare();
const destination = path.join(root, 'test/ui/out/markdown');
fs.rmSync(destination, { recursive: true, force: true });
try {
    const child = spawn(vscodeExecutablePath, [fixture, `--extensionDevelopmentPath=${root}`,
        `--extensionTestsPath=${path.join(root, 'test/vscode/markdown.cjs')}`,
        `--extensions-dir=${extensionsDir}`, `--user-data-dir=${userData}`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        ...(process.env.CATENARY_UI_HEADED ? [] : ['--ozone-platform=headless'])],
        { stdio: 'inherit', env: { ...process.env, CATENARY_MARKDOWN_OUT: destination } });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    const code = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(code)); });
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Markdown e2e exited with ${code}`);
} finally {
    cleanup();
}
