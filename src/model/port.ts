// The model as turtle-lsp answers it: one turtle/query request per question, the answer as RDF/JS terms. Catenary holds no copy of the model.
import type { Quad, Term } from '@rdfjs/types';
import { rdf } from '../catenary/rdf/terms';
import type { JsonTerm, JsonTriple, QueryAnswer } from '../node/sparql-endpoint';

/** One SELECT row: variable name → term. An unbound variable is absent. */
export type Row = Record<string, Term>;

/** The questions Catenary asks about the model. `files`: the file paths of the documents to query; omitted: every document of the workspace. */
export interface ModelPort {
    select(query: string, files?: string[]): Promise<Row[]>;
    construct(query: string, files?: string[]): Promise<Quad[]>;
    ask(query: string, files?: string[]): Promise<boolean>;
}

/**
 * `query` once per file of `files` (`files: [file]`), the rows of each with the path of its file. The file is the scope: the server has no
 * named graphs. For IRI subjects only: the blank-node labels of two file sets are not comparable, so a blank-node query runs once over the folder.
 */
export async function byFile(port: ModelPort, files: string[], query: string): Promise<(Row & { file: string })[]> {
    const answers = await Promise.all(files.map(file => port.select(query, [file])));
    return answers.flatMap((rows, i) => rows.map(r => Object.assign(r, { file: files[i] }) as Row & { file: string }));
}

/** Runs one query text over the given file paths and gives the turtle/query answer. */
export type RunQuery = (query: string, files?: string[]) => Promise<QueryAnswer>;

const BLANK = 'urn:skolem:blank:';
const pad = (n: string, w: number) => n.padStart(w, '0');

/** The IRI of an LSP blank-node id (`_:<document>:<n>`): `urn:skolem:blank:<d padded 6>-<n padded 8>`; another value stays as given. */
export function toEngine(id: string): string {
    if (!id.startsWith('_:')) return id;
    const m = /^_:(\d+):(\d+)$/.exec(id);
    return m && m[1].length <= 6 && m[2].length <= 8 ? `${BLANK}${pad(m[1], 6)}-${pad(m[2], 8)}` : `${BLANK}x${encodeURIComponent(id.slice(2))}`;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** A turtle/query term as an RDF/JS term. A blank-node label `<d>:<n>` becomes the named node `toEngine('_:<d>:<n>')`, a triple term a quad term. */
function termOf(t: JsonTerm): Term {
    switch (t.type) {
        case 'uri': return rdf.namedNode(t.value);
        case 'bnode': return rdf.namedNode(toEngine('_:' + t.value));
        case 'literal': {
            if (t['xml:lang']) return rdf.literal(t.value, t['xml:lang']);
            const datatype = t.datatype && t.datatype !== XSD_STRING && t.datatype !== LANG_STRING ? rdf.namedNode(t.datatype) : undefined;
            return rdf.literal(t.value, datatype);
        }
        case 'triple': return quadOf(t.value);
    }
}

const quadOf = (t: JsonTriple): Quad => rdf.quad(termOf(t.subject) as Quad['subject'], termOf(t.predicate) as Quad['predicate'], termOf(t.object) as Quad['object']);

function expect<K extends QueryAnswer['kind']>(answer: QueryAnswer, kind: K): Extract<QueryAnswer, { kind: K }> {
    if (answer.kind !== kind) throw new Error(`turtle/query answered ${answer.kind} to a ${kind} query`);
    if ('omitted' in answer && answer.omitted > 0) throw new Error(`turtle/query omitted ${answer.omitted} results: the query hit maxRows`);
    return answer as Extract<QueryAnswer, { kind: K }>;
}

/** turtle-lsp answers at most this many turtle/query requests at once; one more fails with "4 queries are running". */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

/** `run` with at most MAX_IN_FLIGHT requests in flight in this process (every port sends to the same server); the others wait in order. */
async function limited<T>(run: () => Promise<T>): Promise<T> {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>(resolve => waiting.push(resolve));
    else inFlight++;
    try {
        return await run();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else inFlight--;
    }
}

/** A ModelPort over a function that sends turtle/query. The requests of every port of the process share MAX_IN_FLIGHT. */
export function answerPort(send: RunQuery): ModelPort {
    const run: RunQuery = (query, files) => limited(() => send(query, files));
    return {
        async select(query, files) {
            return expect(await run(query, files), 'select').results.bindings.map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, termOf(v)])));
        },
        async construct(query, files) {
            return expect(await run(query, files), 'construct').triples.map(quadOf);
        },
        async ask(query, files) {
            return expect(await run(query, files), 'ask').boolean;
        },
    };
}
