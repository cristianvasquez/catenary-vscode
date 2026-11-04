// The local SPARQL endpoint in VS Code: the catenary.sparql.port and catenary.sparql.allowOrigins settings, the start, stop and copy URL commands, a status bar item.
import * as vscode from 'vscode';
import { startSparqlEndpoint, type QueryFn, type SparqlEndpoint } from '../node/sparql-endpoint';
import { requestQuery, type TurtleApi } from '../node/turtle-api';

const SETTING = 'catenary.sparql.port';
const ORIGINS_SETTING = 'catenary.sparql.allowOrigins';
const METHOD_NOT_FOUND = -32601;

/** Starts the endpoint when the setting is over 0, follows the setting, and registers the commands. */
export function activateSparqlEndpoint(_context: vscode.ExtensionContext, api: TurtleApi, log: (line: string) => void): vscode.Disposable {
    let endpoint: SparqlEndpoint | undefined;
    /** The allow-list the running endpoint started with. */
    let endpointOrigins: string[] = [];
    /** Serializes start and stop. */
    let queue: Promise<unknown> = Promise.resolve();
    let missingShown = false;

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
    status.command = 'catenary.sparql.copyUrl';

    const query: QueryFn = async text => {
        try {
            return await requestQuery(api, { query: text });
        } catch (err) {
            if ((err as { code?: unknown } | undefined)?.code === METHOD_NOT_FOUND && !missingShown) {
                missingShown = true;
                void vscode.window.showErrorMessage('The Turtle language server does not have turtle/query; update it to 0.14.0 or later.');
            }
            throw err;
        }
    };

    const configured = () => vscode.workspace.getConfiguration().get<number>(SETTING, 0);
    const configuredOrigins = () => vscode.workspace.getConfiguration().get<string[]>(ORIGINS_SETTING, []).filter(o => typeof o === 'string');

    const stopNow = async () => {
        const current = endpoint;
        if (!current) return;
        endpoint = undefined;
        status.hide();
        await current.close();
        log(`SPARQL endpoint stopped: ${current.url}`);
    };

    const startNow = async (port: number): Promise<SparqlEndpoint | undefined> => {
        const allowOrigins = configuredOrigins();
        if (endpoint) {
            const sameOrigins = allowOrigins.length === endpointOrigins.length && allowOrigins.every((o, i) => o === endpointOrigins[i]);
            if (sameOrigins && (endpoint.port === port || port === 0)) return endpoint;
            if (port === 0) port = endpoint.port;
            await stopNow();
        }
        try {
            endpoint = await startSparqlEndpoint(query, { port, log: line => log(`SPARQL ${line}`), allowOrigins });
            endpointOrigins = allowOrigins;
        } catch (err) {
            const message = `SPARQL endpoint did not start on port ${port}: ${err instanceof Error ? err.message : String(err)}`;
            log(message);
            void vscode.window.showErrorMessage(message);
            return undefined;
        }
        log(`SPARQL endpoint started: ${endpoint.url}`);
        status.text = `$(database) SPARQL :${endpoint.port}`;
        status.tooltip = endpoint.url;
        status.show();
        return endpoint;
    };

    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const next = queue.then(task);
        queue = next.catch(err => log(`SPARQL endpoint: ${err instanceof Error ? err.message : String(err)}`));
        return next;
    };
    const start = (port: number) => enqueue(() => startNow(port));
    const stop = () => enqueue(stopNow);
    /** Restarts a running endpoint on its port with the current allow-list. */
    const restart = () => enqueue(async () => endpoint ? startNow(endpoint.port) : undefined);
    const follow = () => {
        const port = configured();
        return port > 0 ? start(port) : stop();
    };

    void follow();

    const disposables = [
        { dispose: () => { void stop(); } },
        status,
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(SETTING)) void follow();
            else if (e.affectsConfiguration(ORIGINS_SETTING)) void restart();
        }),
        vscode.commands.registerCommand('catenary.sparql.start', async () => {
            const started = await start(configured());
            if (started) void vscode.window.showInformationMessage(`SPARQL endpoint: ${started.url}`);
        }),
        vscode.commands.registerCommand('catenary.sparql.stop', () => stop()),
        vscode.commands.registerCommand('catenary.sparql.copyUrl', async () => {
            if (!endpoint) {
                void vscode.window.showInformationMessage('The SPARQL endpoint is not running.');
                return;
            }
            await vscode.env.clipboard.writeText(endpoint.url);
            void vscode.window.showInformationMessage(`Copied ${endpoint.url}`);
        }),
    ];
    return vscode.Disposable.from(...disposables);
}
