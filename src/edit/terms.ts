// RDF factory, statement keys, the view vocabulary and canvas ids of the view edits. No graph, no store: moved from rdf-files/terms.ts, rdf/views.ts, rdf/ids.ts, rdf/vocabulary.ts.
import type { NamedNode, Term } from '@rdfjs/types';
import { createHash, randomBytes } from 'crypto';
import rdf from 'rdf-ext';
import { idIri, iriId, relationIdOf, unescapeId } from '../catenary/model/ids';
import { NS, RDF_TYPE, RDFS_LABEL } from '../catenary/model/terms';

export { rdf };

type KeyTerm = { termType: string; value: string; language?: string; direction?: string | null; datatype?: { value: string }; subject?: KeyTerm; predicate?: KeyTerm; object?: KeyTerm };

/** Key of a term, as N-Triples text: `<iri>`, `_:label`, `"v"@lang--dir`, `"v"^^<datatype>`, `<<( s p o )>>` (RDF 1.2 triple term). */
export function termKey(t: KeyTerm): string {
    switch (t.termType) {
        case 'NamedNode': return `<${t.value}>`;
        case 'BlankNode': return `_:${t.value}`;
        case 'Literal': return JSON.stringify(t.value) + (t.language ? `@${t.language}${t.direction ? `--${t.direction}` : ''}` : `^^<${t.datatype?.value}>`);
        case 'Quad': return `<<( ${termKey(t.subject!)} ${termKey(t.predicate!)} ${termKey(t.object!)} )>>`;
        case 'DefaultGraph': return '';
        default: return `?${t.value}`;
    }
}

/** Key of a statement: subject, predicate, object. The graph is not part of it. */
export const tripleKey = (q: { subject: KeyTerm; predicate: KeyTerm; object: KeyTerm }) => `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)}`;

export const P = {
    type: rdf.namedNode(RDF_TYPE),
    label: rdf.namedNode(RDFS_LABEL),
    /** RDF 1.2: `r rdf:reifies <<( s p o )>>`. A placement of a connector is a reifier of its triple. */
    reifies: rdf.namedNode(NS.rdf + 'reifies')
};

const v = (local: string) => rdf.namedNode(NS.view + local);

/** The view vocabulary (rdf/views.ts `V`). */
export const V = {
    View: v('View'), Placement: v('Placement'),
    Frame: v('Frame'), Pill: v('Pill'), Note: v('Note'), FileRef: v('FileRef'), EntityGroup: v('EntityGroup'),
    arrow: v('arrow'), member: v('member'), element: v('element'), view: v('view'), text: v('text'), file: v('file'),
    x: v('x'), y: v('y'), width: v('width'), height: v('height'), color: v('color'), display: v('display'),
    fromSide: v('fromSide'), toSide: v('toSide'), vertices: v('vertices'), of: v('of'), keptByLines: v('keptByLines'), description: v('description')
};

/** An IRI that a read made from a blank node (rdf-core/skolem.ts). */
export const isSkolem = (t: Term) => t.termType === 'NamedNode' && t.value.startsWith('urn:skolem:');

// An absolute IRI: a wrong id gives undefined, not an exception.
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;

const iri = (value: string | undefined) => value !== undefined && IRI.test(value) ? rdf.namedNode(value) : undefined;

/** Id of an instance, view, view element or shape. */
export const elementId = (t: NamedNode): string => iriId(t.value);

/** Id of a relation (s, p, o). */
export const relationId = (s: NamedNode, p: NamedNode, o: NamedNode): string => relationIdOf(s.value, p.value, o.value);

/** Term of an element id. Undefined for a relation id or a malformed id. */
export const elementTerm = (id: string): NamedNode | undefined => iri(idIri(id));

/** Triple of a relation id. */
export function relationTriple(id: string): { s: NamedNode; p: NamedNode; o: NamedNode } | undefined {
    const parts = id.split('-');
    if (parts.length !== 4 || parts[0] !== 'r') return undefined;
    const [s, p, o] = parts.slice(1).map(x => iri(unescapeId(x)));
    return s && p && o ? { s, p, o } : undefined;
}

/** `<view>/p/<hash>`: 12 hex characters of the placed term (an element, or a triple for a connector). A view places a term at most once. */
export const placementIri = (view: string, placed: Term): NamedNode =>
    rdf.namedNode(`${view}/p/` + createHash('sha256').update(termKey(placed)).digest('hex').slice(0, 12));

/** `<view>/m/<id>`, `id` 6 random base-36 characters. The caller checks that it is free. */
export const newMarkIri = (view: string): NamedNode => rdf.namedNode(`${view}/m/` + [...randomBytes(6)].map(b => (b % 36).toString(36)).join(''));
