// The ModelPort of the extension host: turtle/query over the running turtle extension's language client.
import { pathToFileURL } from 'node:url';
import { answerPort, type ModelPort } from '../model/port';
import { QUERY_MISSING, requestQuery, type TurtleApi } from './turtle-api';

const METHOD_NOT_FOUND = -32601;

/** Sends each query with `requestQuery`; file paths go as file URIs. A server without turtle/query (JSON-RPC -32601) gives an Error with QUERY_MISSING. */
export function nodePort(api: TurtleApi): ModelPort {
    return answerPort(async (query, files) => {
        try {
            return await requestQuery(api, files ? { query, files: files.map(f => pathToFileURL(f).href) } : { query });
        } catch (err) {
            if ((err as { code?: unknown } | undefined)?.code === METHOD_NOT_FOUND) throw new Error(QUERY_MISSING);
            throw err;
        }
    });
}
