// Load the RDF notations; adapted from Catenary packages/rdf/src/notations.ts.
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { Parser } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import { Notations, notations } from '../model/notation';
import type { NQuad, NTerm } from '../model/notation-graph';
import { TermJSON, termToJSON } from '../model/terms';
import { skolemize } from '../rdf-core/skolem';
import { rdf } from './terms';


/** The folder of the built-in notation files: next to the package source or build, or next to the backend bundle. */
const NOTATIONS_DIR = fileURLToPath(new URL('./notations/', import.meta.url));


/** A term of the store as JSON. Undefined: a blank node (the store has none) or another term. */
function nterm(t: Term): NTerm | undefined {
    if (t.termType === 'Quad') {
        const s = nterm(t.subject), p = termToJSON(t.predicate), o = nterm(t.object);
        return s && p && o ? { termType: 'Triple', value: '', subject: s, predicate: p, object: o } : undefined;
    }
    return termToJSON(t);
}


/** Quads as engine triples. The graph is dropped: the engine reads the union of all graphs. */
function nquads(quads: Iterable<Quad>): NQuad[] {
    const out: NQuad[] = [];
    for (const q of quads) {
        const s = nterm(q.subject), o = nterm(q.object);
        if (s?.termType === 'NamedNode' && o) out.push({ subject: s as TermJSON, predicate: q.predicate.value, object: o });
    }
    return out;
}


let builtIn: Notations | undefined;


/** The statements of all `*.ttl` files of `dir`, in file order then document order, with their blank nodes. */
export function parseNotationFiles(dir = NOTATIONS_DIR): Quad[] {
    const quads: Quad[] = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.ttl')).sort())
        quads.push(...new Parser({ format: 'text/turtle' }).parse(readFileSync(path.join(dir, f), 'utf8')));
    return quads;
}


/** The notations: all `*.ttl` files of `dir`, blank nodes replaced by IRIs. The built-in folder is read once. */
export function readNotations(dir = NOTATIONS_DIR): Notations {
    if (dir === NOTATIONS_DIR && builtIn) return builtIn;
    const quads = parseNotationFiles(dir);
    const n = notations(nquads(skolemize(quads.map(q => rdf.quad(q.subject, q.predicate, q.object))).quads));
    if (dir === NOTATIONS_DIR) builtIn = n;
    return n;
}


/** A placement key (nkey) as an engine term: an IRI, or a statement between IRIs. */
export function keyTerm(k: string): NTerm {
    const m = /^<<\(<([^<>]*)> <([^<>]*)> <([^<>]*)>\)>>$/.exec(k);
    if (m) return { termType: 'Triple', value: '', subject: { termType: 'NamedNode', value: m[1] }, predicate: { termType: 'NamedNode', value: m[2] }, object: { termType: 'NamedNode', value: m[3] } };
    const iri = /^<([^<>]*)>$/.exec(k);
    return { termType: 'NamedNode', value: iri ? iri[1] : k };
}
