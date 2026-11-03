// The ModelPort of the browser page: turtle/query to the embedded turtle-lsp (engine.wasm in a worker, built from the fork).
import { answerPort, type ModelPort } from '../model/port';
import type { QueryAnswer } from '../node/sparql-endpoint';
import { fileUriOf } from './files';
import type { LspClient } from './turtle-lsp/editor-lsp.js';

/** Sends each query with `lsp.request('turtle/query', …)`; file paths of the in-memory file system go as file URIs. */
export function webPort(lsp: LspClient): ModelPort {
    return answerPort(async (query, files) =>
        await lsp.request('turtle/query', files ? { query, files: files.map(fileUriOf) } : { query }) as QueryAnswer);
}
