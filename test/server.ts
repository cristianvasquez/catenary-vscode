// The turtle-lsp fork over stdio on a fixture folder, for tests of the ModelPort. Approach of the fork's test/lsp-client.mjs; nothing imported from the fork.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { ModelPort } from '../src/model/port';
import { nodePort } from '../src/node/port';
import type { QueryAnswer } from '../src/node/sparql-endpoint';
import type { GraphParams, GraphResult, QueryParams } from '../src/node/turtle-api';

/** The binary under test: TURTLE_LSP, else the release build of ~/os/rdf/turtle-lsp. */
const serverPath = process.env.TURTLE_LSP ?? join(homedir(), 'os/rdf/turtle-lsp/target/release/turtle-lsp');

interface TestServer {
    port(): ModelPort;
    /** The raw turtle/query answer. */
    query(params: QueryParams): Promise<QueryAnswer>;
    /** The raw turtle/graph answer (the input of the old pipeline, graphOf). */
    graph(params: GraphParams): Promise<GraphResult>;
    open(uri: string, text: string, languageId?: string): void;
    change(uri: string, text: string): void;
    stop(): Promise<void>;
}

/** Starts the server with `folder` as the workspace folder and waits until the index has at least `triples` triples. */
export async function startServer(folder: string, triples: number, timeoutMs = 10000): Promise<TestServer> {
    if (!existsSync(serverPath)) throw new Error(`turtle-lsp binary not found at ${serverPath}: build it in the fork (branch turtle-query) with \`cargo build --release --locked\`, or set TURTLE_LSP`);
    const proc = spawn(serverPath, [], { cwd: folder, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.on('error', () => {});
    proc.stderr.resume();
    const exited = new Promise<void>(r => proc.once('exit', () => r()));
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
    conn.onRequest(() => null);
    conn.listen();
    const stop = async () => {
        const late = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref());
        try {
            await Promise.race([conn.sendRequest('shutdown'), late(500)]);
            await Promise.race([conn.sendNotification('exit'), late(500)]);
        } catch { /* the server may be gone */ }
        await Promise.race([exited, late(3000)]);
        conn.dispose();
        proc.kill();
    };

    const rootUri = pathToFileURL(folder).href;
    await conn.sendRequest('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'ws' }], capabilities: {} });
    await conn.sendNotification('initialized', {});

    const port = nodePort({
        client: () => ({ isRunning: () => true, sendRequest: <R>(method: string, params: unknown) => conn.sendRequest<R>(method, params) }),
        idle: async () => {},
    });
    const versions = new Map<string, number>();

    // The initial index lands in the background: ask until it has every triple.
    const end = Date.now() + timeoutMs;
    for (;;) {
        const [row] = await port.select('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }');
        const n = Number(row?.n?.value ?? 0);
        if (n >= triples) break;
        if (Date.now() > end) {
            await stop();
            throw new Error(`the workspace has ${n} triples, not ${triples}`);
        }
        await new Promise(r => setTimeout(r, 50));
    }

    return {
        port: () => port,
        query: params => conn.sendRequest<QueryAnswer>('turtle/query', params),
        graph: params => conn.sendRequest<GraphResult>('turtle/graph', params),
        open(uri, text, languageId = 'turtle') {
            versions.set(uri, 1);
            void conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
        },
        change(uri, text) {
            const version = (versions.get(uri) ?? 1) + 1;
            versions.set(uri, version);
            void conn.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
        },
        stop,
    };
}
