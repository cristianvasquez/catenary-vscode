// The notation figures of a view from one prefetch of turtle/query answers: an in-memory TripleIndex, dropped after the call.
import type { Quad, Term } from '@rdfjs/types';
import { deriveFigures, type Notations } from '../catenary/model/notation';
import { NQuad, NT, NTerm, Path, RDF, SH, TripleIndex, iri, nkey, parseShaclPath } from '../catenary/model/notation-graph';
import { placementsOf, viewFigures, type ViewFigures } from '../catenary/model/notation-join';
import { NS, termToJSON, type TermJSON } from '../catenary/model/terms';
import { keyTerm, readNotations } from '../catenary/rdf/notations';
import type { ModelPort } from '../model/port';
import type { ShapesModelRecords } from './shapes';

/** The IRI prefix of a blank node in a port answer (port.ts, toEngine): the server cannot be asked about it by name. */
const BLANK = 'urn:skolem:blank:';

const SUBCLASS = NS.rdfs + 'subClassOf';

/** A term of a port answer as an engine term. Undefined: a blank node term that the port did not name, or another term. */
function nterm(t: Term): NTerm | undefined {
    if (t.termType === 'Quad') {
        const s = nterm(t.subject), p = termToJSON(t.predicate), o = nterm(t.object);
        return s && p && o ? { termType: 'Triple', value: '', subject: s, predicate: p, object: o } : undefined;
    }
    return termToJSON(t);
}

/** Quads as engine triples, graphs dropped: the engine reads the union. */
function nquads(quads: Iterable<Quad>): NQuad[] {
    const out: NQuad[] = [];
    for (const q of quads) {
        const s = nterm(q.subject), o = nterm(q.object);
        if (s?.termType === 'NamedNode' && o) out.push({ subject: s as TermJSON, predicate: q.predicate.value, object: o });
    }
    return out;
}

/** What the prefetch read completely (nkey): every statement of a subject (`outAll`) or an object (`inAll`), of a subject and predicate (`outP`), of a predicate. */
interface Coverage {
    outAll: Set<string>; outP: Set<string>; inAll: Set<string>; predicates: Set<string>;
}

/**
 * A TripleIndex over the prefetched statements. A read that the prefetch did not cover gives what the index has (possibly nothing) and
 * counts as a miss: on a covered workspace the derivation reads only covered terms.
 */
class PrefetchIndex extends TripleIndex {
    readonly missed = new Set<string>();

    constructor(quads: readonly NQuad[], private readonly covered: Coverage) { super(quads); }

    /** A literal or a triple term has no statements as subject. */
    private outRead(s: NTerm, p?: string): void {
        if (s.termType !== 'NamedNode') return;
        const k = nkey(s);
        if (this.covered.outAll.has(k) || p !== undefined && (this.covered.predicates.has(p) || this.covered.outP.has(`${k} ${p}`))) return;
        this.missed.add(`out ${k} ${p ?? '*'}`);
    }

    private inRead(o: NTerm, p?: string): void {
        const k = nkey(o);
        if (this.covered.inAll.has(k) || p !== undefined && this.covered.predicates.has(p)) return;
        this.missed.add(`in ${k} ${p ?? '*'}`);
    }

    override objects(s: NTerm, p: string): NTerm[] { this.outRead(s, p); return super.objects(s, p); }
    override subjects(p: string, o: NTerm): TermJSON[] { this.inRead(o, p); return super.subjects(p, o); }
    override predicates(s: NTerm): string[] { this.outRead(s); return super.predicates(s); }
    override incoming(o: NTerm): [string, TermJSON[]][] { this.inRead(o); return super.incoming(o); }
    override subjectsOfP(p: string): TermJSON[] { if (!this.covered.predicates.has(p)) this.missed.add(`predicate ${p}`); return super.subjectsOfP(p); }
    override objectsOfP(p: string): NTerm[] { if (!this.covered.predicates.has(p)) this.missed.add(`predicate ${p}`); return super.objectsOfP(p); }
}

/** The number of statements a path walks; a repetition counts once (the list cells and rdfs:subClassOf are prefetched whole). */
function pathLength(path: Path): number {
    if ('p' in path || 'rev' in path) return 1;
    if ('inv' in path) return pathLength(path.inv);
    if ('seq' in path) return path.seq.reduce((n, step) => n + pathLength(step), 0);
    if ('alt' in path) return Math.max(0, ...path.alt.map(pathLength));
    return pathLength('star' in path ? path.star : 'plus' in path ? path.plus : path.opt);
}

/** D: the longest role path (sh:path of a property shape of a figure) among the notations. */
export function roleDepth(notes: Notations): number {
    const N = notes.index, figures = N.subjects(RDF('type'), iri(NT('Figure')));
    const paths = figures.flatMap(f => N.objects(f, SH('property'))).flatMap(ps => N.objects(ps, SH('path')));
    return Math.max(1, ...paths.map(p => pathLength(parseShaclPath(N, p))));
}

const values = (terms: Iterable<string>) => [...terms].map(t => `<${t}>`).join(' ');

/** (c) The statements of the terms as subject or object, over every document (a view reference reads the statements of another view). */
const NEIGHBOURS = (terms: string[]) => `CONSTRUCT { ?s ?p ?o } WHERE { { VALUES ?s { ${values(terms)} } ?s ?p ?o } UNION { VALUES ?o { ${values(terms)} } ?s ?p ?o } }`;

/** (d) Every rdfs:subClassOf statement of the model files. */
const SUBCLASSES = `CONSTRUCT { ?c <${SUBCLASS}> ?d } WHERE { ?c <${SUBCLASS}> ?d }`;

/** (e) The RDF list cells below the objects of the terms, blank cells included. */
const LIST_CELLS = (terms: string[]) => `CONSTRUCT { ?c <${RDF('first')}> ?f . ?c <${RDF('rest')}> ?r } WHERE { VALUES ?x { ${values(terms)} } ?x ?p ?h . ?h <${RDF('rest')}>* ?c . ?c <${RDF('first')}> ?f . ?c <${RDF('rest')}> ?r }`;

/** A placed term or a term the caller asks about, as the IRIs to read around: an IRI, or the IRI ends of a statement. */
function iris(t: NTerm): string[] {
    if (t.termType === 'Triple') return [...iris(t.subject), ...iris(t.object)];
    return t.termType === 'NamedNode' ? [t.value] : [];
}

const IRI = /^[^\s<>"{}|^`\\]+$/;

/** The figures of a view, its placements and their join, and the number of index reads that the prefetch did not cover. */
export type PrefetchedFigures = ViewFigures & { misses: number };

/**
 * The figures of a view from one prefetch, with `deriveFigures` unchanged (the old viewFiguresOf in catenary/rdf/notations.ts, `keep` false).
 * The prefetch: (a) the view quads; (b) the shapes closure of `shapes`; (c) the statements around the placed terms and `also`, D times
 * outwards (D = roleDepth); (d) rdfs:subClassOf over `modelFiles`; (e) the list cells below the terms of (c).
 */
export async function viewFiguresOf(port: ModelPort, viewIri: string, shapes: ShapesModelRecords, modelFiles: string[], also: NTerm[] = []): Promise<PrefetchedFigures> {
    const notes = readNotations(), depth = roleDepth(notes);
    const [view, subclasses] = await Promise.all([
        port.construct(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${viewIri}> { ?s ?p ?o } }`),
        port.construct(SUBCLASSES, modelFiles)
    ]);
    const viewQuads = nquads(view);
    const placed = placementsOf(new TripleIndex(viewQuads), viewIri);
    // As the old viewFiguresOf: a placement of another term (a statement with a literal) has no figure; the join reports it.
    const scope = [...[...placed.keys()].map(keyTerm), ...also].filter(t => t.termType === 'Triple' || IRI.test(t.value));

    const covered: Coverage = { outAll: new Set(), outP: new Set(), inAll: new Set(), predicates: new Set([SUBCLASS]) };
    // The closure holds every sh: statement of the model files without the manifest (shapePart starts at each subject with one), and the
    // statements of its subjects in the documents where they are shapes.
    const closure = nquads(shapes.closure);
    for (const q of closure) {
        covered.outAll.add(nkey(q.subject));
        if (q.predicate.startsWith(NS.sh)) covered.predicates.add(q.predicate);
    }

    const neighbours: NQuad[] = [], expanded = new Set<string>();
    let frontier = [...new Set([viewIri, ...scope.flatMap(iris)])];
    for (let round = 0; round < depth && frontier.length; round++) {
        for (const t of frontier) { expanded.add(t); covered.outAll.add(`<${t}>`); covered.inAll.add(`<${t}>`); }
        const found = nquads(await port.construct(NEIGHBOURS(frontier)));
        neighbours.push(...found);
        // A blank node cannot be named in a query: its statements come from the closure or the list cells, else its reads are misses.
        const next = new Set<string>();
        for (const q of found) for (const t of [q.subject, q.object].flatMap(iris)) if (!expanded.has(t) && !t.startsWith(BLANK)) next.add(t);
        frontier = [...next];
    }
    const cells = expanded.size ? nquads(await port.construct(LIST_CELLS([...expanded]))) : [];
    for (const q of cells) covered.outP.add(`${nkey(q.subject)} ${q.predicate}`);

    const index = new PrefetchIndex([...viewQuads, ...closure, ...neighbours, ...nquads(subclasses), ...cells], covered);
    const derivation = deriveFigures(index, notes, viewIri, scope, new Map());
    const result = viewFigures(index, notes, viewIri, derivation);
    return { ...result, misses: index.missed.size };
}
