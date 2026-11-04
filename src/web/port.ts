// The ModelPort of the browser page: turtle/query to the embedded turtle-lsp (engine.wasm in a worker, built from turtle-lsp 0.14.0 or later).
import { answerPort, MAX_ROWS, type ModelPort } from '../model/port';
import type { QueryAnswer } from '../node/sparql-endpoint';
import { fileUriOf } from './files';
import type { LspClient } from './turtle-lsp/editor-lsp.js';

/** Sends each query with `lsp.request('turtle/query', …)`; file paths of the in-memory file system go as file URIs. */
export function webPort(lsp: LspClient): ModelPort {
    return answerPort(async (query, files) =>
        await lsp.request('turtle/query', { query, maxRows: MAX_ROWS, ...(files ? { files: files.map(fileUriOf) } : {}) }) as QueryAnswer);
}
