// The model as turtle-lsp answers it: one turtle/query request per question, the answer as RDF/JS terms. Catenary holds no copy of the model.
import type { Quad, Term } from '@rdfjs/types';
import { rdf } from '../catenary/rdf/terms';
import type { JsonTerm, JsonTriple, QueryAnswer } from '../node/sparql-endpoint';
import { toEngine } from './nquads';

/** One SELECT row: variable name → term. An unbound variable is absent. */
export type Row = Record<string, Term>;

/** The questions Catenary asks about the model. `files`: the file paths of the documents to query; omitted: every document of the workspace. */
export interface ModelPort {
    select(query: string, files?: string[]): Promise<Row[]>;
    construct(query: string, files?: string[]): Promise<Quad[]>;
    ask(query: string, files?: string[]): Promise<boolean>;
}

/** Runs one query text over the given file paths and gives the turtle/query answer. */
export type RunQuery = (query: string, files?: string[]) => Promise<QueryAnswer>;

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

/** A ModelPort over a function that sends turtle/query. */
export function answerPort(run: RunQuery): ModelPort {
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
