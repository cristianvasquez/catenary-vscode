// Write quads as N-Quads text for a bulk store load; LSP blank-node ids become engine IRIs.

/**
 * A term: the NTerm of src/node/quads.ts, or an RDF/JS term. A literal datatype is an IRI string or a named node;
 * a triple term is `Triple` (NTerm) or `Quad` (RDF/JS).
 */
interface NQuadsTerm {
    termType: string;
    value: string;
    language?: string;
    direction?: string | null;
    datatype?: string | { value: string };
    subject?: NQuadsTerm;
    predicate?: string | NQuadsTerm;
    object?: NQuadsTerm;
}

/** A quad: the NQuad of src/node/quads.ts plus a graph IRI, or an RDF/JS quad. An empty graph IRI or the default graph: no graph label. */
export interface NQuadsQuad {
    subject: NQuadsTerm;
    predicate: string | NQuadsTerm;
    object: NQuadsTerm;
    graph: string | NQuadsTerm;
}

// Preserve blank-node document order when assigning engine IRIs.
const BLANK = 'urn:skolem:blank:';
const pad = (n: string, w: number) => n.padStart(w, '0');

/** The engine IRI of an LSP blank-node id (`_:<document>:<n>`); another value stays as given. */
export function toEngine(id: string): string {
    if (!id.startsWith('_:')) return id;
    const m = /^_:(\d+):(\d+)$/.exec(id);
    return m && m[1].length <= 6 && m[2].length <= 8 ? `${BLANK}${pad(m[1], 6)}-${pad(m[2], 8)}` : `${BLANK}x${encodeURIComponent(id.slice(2))}`;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const hex = (c: string) => {
    const n = c.codePointAt(0)!;
    return n > 0xffff ? `\\U${n.toString(16).toUpperCase().padStart(8, '0')}` : `\\u${n.toString(16).toUpperCase().padStart(4, '0')}`;
};

/** IRIREF: the characters that N-Quads does not allow in an IRI are written as \u escapes. */
function iri(value: string): string {
    return `<${value.replace(/[\u0000- <>"{}|^`\\]/g, hex)}>`;
}

const STRING_ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r' };

/** STRING_LITERAL_QUOTE: quote, backslash, line feed and carriage return are escaped. */
function string(value: string): string {
    return `"${value.replace(/["\\\n\r]/g, c => STRING_ESCAPES[c])}"`;
}

const valueOf = (t: string | { value: string }) => typeof t === 'string' ? t : t.value;

function term(t: NQuadsTerm): string {
    switch (t.termType) {
        case 'NamedNode': return iri(t.value);
        case 'BlankNode': return iri(toEngine(t.value.startsWith('_:') ? t.value : `_:${t.value}`));
        case 'Literal': {
            const datatype = t.datatype === undefined ? undefined : valueOf(t.datatype);
            if (t.language) return `${string(t.value)}@${t.language}${t.direction ? `--${t.direction}` : ''}`;
            return datatype && datatype !== XSD_STRING && datatype !== LANG_STRING ? `${string(t.value)}^^${iri(datatype)}` : string(t.value);
        }
        case 'Triple':
        case 'Quad': return `<<( ${term(t.subject!)} ${iri(valueOf(t.predicate!))} ${term(t.object!)} )>>`;
        default: throw new Error(`No N-Quads form for a ${t.termType} term.`);
    }
}

/** N-Quads text: one line per quad. A blank node is written as its engine IRI (toEngine), a triple term as `<<( s p o )>>`. */
export function nquadsOf(quads: Iterable<NQuadsQuad>): string {
    let out = '';
    for (const q of quads) {
        const graph = valueOf(q.graph);
        out += `${term(q.subject)} ${iri(valueOf(q.predicate))} ${term(q.object)}${graph ? ` ${iri(graph)}` : ''} .\n`;
    }
    return out;
}
