// The notation figures of a view from one prefetch of turtle/query answers: an in-memory TripleIndex, dropped after the call.
import type { Quad, Term } from '@rdfjs/types';
import { deriveFigures } from '../catenary/model/notation';
import { NQuad, NTerm, RDF, TripleIndex, nkey } from '../catenary/model/notation-graph';
import { placementsOf, viewFigures, type ViewFigures } from '../catenary/model/notation-join';
import { NS, termToJSON, type TermJSON } from '../catenary/model/terms';
import { keyTerm, readNotations } from '../catenary/rdf/notations';
import type { ModelPort } from '../model/port';
import type { ShapesModelRecords } from './shapes';

/** The IRI prefix of a blank node in a port answer (port.ts, toEngine): the server cannot be asked about it by name, only through the IRI that reaches it. */
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


/** What the prefetch read completely (nkey): every statement of a subject (`outAll`) or an object (`inAll`), of a subject and predicate (`outP`), of an object and predicate (`inP`), of a predicate. */
interface Coverage {
    outAll: Set<string>; outP: Set<string>; inAll: Set<string>; inP: Set<string>; predicates: Set<string>;
}

/** A read that the prefetch did not cover: the statements of a term as subject (`out`) or object (`in`), of predicate `p` or of any predicate; or every statement of a predicate. */
type Miss = { kind: 'out' | 'in'; term: NTerm; p?: string } | { kind: 'predicate'; p: string };

const missKey = (m: Miss) => m.kind === 'predicate' ? `predicate ${m.p}` : `${m.kind} ${nkey(m.term)} ${m.p ?? '*'}`;

/**
 * A TripleIndex over the prefetched statements. A read that the prefetch did not cover gives what the index has (possibly nothing) and
 * counts as a miss: on a covered workspace the derivation reads only covered terms. A miss on a blank node is never fetched by name.
 */
class PrefetchIndex extends TripleIndex {
    /** The misses by their text: `missed.size` is the number of distinct reads outside the prefetch. */
    readonly missed = new Map<string, Miss>();

    constructor(quads: readonly NQuad[], private readonly covered: Coverage) { super(quads); }

    private miss(m: Miss): void { this.missed.set(missKey(m), m); }

    /** A literal or a triple term has no statements as subject. */
    private outRead(s: NTerm, p?: string): void {
        if (s.termType !== 'NamedNode') return;
        const k = nkey(s);
        if (this.covered.outAll.has(k) || p !== undefined && (this.covered.predicates.has(p) || this.covered.outP.has(`${k} ${p}`))) return;
        this.miss({ kind: 'out', term: s, p });
    }

    private inRead(o: NTerm, p?: string): void {
        const k = nkey(o);
        if (this.covered.inAll.has(k) || p !== undefined && (this.covered.predicates.has(p) || this.covered.inP.has(`${k} ${p}`))) return;
        this.miss({ kind: 'in', term: o, p });
    }

    private predicateRead(p: string): void { if (!this.covered.predicates.has(p)) this.miss({ kind: 'predicate', p }); }

    override objects(s: NTerm, p: string): NTerm[] { this.outRead(s, p); return super.objects(s, p); }
    override subjects(p: string, o: NTerm): TermJSON[] { this.inRead(o, p); return super.subjects(p, o); }
    override predicates(s: NTerm): string[] { this.outRead(s); return super.predicates(s); }
    override incoming(o: NTerm): [string, TermJSON[]][] { this.inRead(o); return super.incoming(o); }
    override subjectsOfP(p: string): TermJSON[] { this.predicateRead(p); return super.subjectsOfP(p); }
    override objectsOfP(p: string): NTerm[] { this.predicateRead(p); return super.objectsOfP(p); }
}

/** (d) Every rdfs:subClassOf statement of the model files. */
const SUBCLASSES = `CONSTRUCT { ?c <${SUBCLASS}> ?d } WHERE { ?c <${SUBCLASS}> ?d }`;

const REST = RDF('rest');

/** The depth of the blank-node closure: shape → property shape → path node → list cell → inverse path node. */
const CLOSURE_DEPTH = 4;

/** At most this many terms in the VALUES list of one query. */
const VALUES_MAX = 200;

/**
 * The UNION branch of the blank-node closure under `?<root>` at `depth`: each level walks list cells (rdf:rest*), then one statement,
 * every node on the way blank. The branch binds the statement at the last level as `?a ?q ?v`.
 */
function closureBranch(root: string, depth: number): string {
    let text = '', prev = `?${root}`;
    const blank = [prev];
    for (let i = 1; i <= depth; i++) {
        const last = i === depth;
        text += `${prev} <${REST}>* ?c${i} . ?c${i} ${last ? '?q ?v' : `?q${i} ?x${i}`} . `;
        blank.push(`?c${i}`);
        if (!last) { prev = `?x${i}`; blank.push(prev); }
    }
    return `{ ${text}FILTER (${blank.map(v => `isBlank(${v})`).join(' && ')}) BIND(?c${depth} AS ?a) }`;
}

/** A term in N-Triples form, for a VALUES list: an IRI or a literal. */
function ntriples(t: TermJSON): string {
    if (t.termType === 'NamedNode') return `<${t.value}>`;
    const text = `"${t.value.replace(/[\\"\n\r]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r' })[c]!)}"`;
    return t.language ? `${text}@${t.language}` : t.datatype ? `${text}^^<${t.datatype}>` : text;
}

/** A group of misses that one query reads: the same kind and predicate; `terms` the subjects or objects (none for a predicate read). */
interface Group { kind: Miss['kind']; p?: string; terms: TermJSON[] }

/**
 * One CONSTRUCT for a group: the statements `?s <p> ?o` with the subjects (`out`) or objects (`in`) in VALUES, `?p` when the read has no
 * predicate, and the blank-node closure under the other end down to CLOSURE_DEPTH. Predicate IRIs in full, no PREFIX.
 * The statement itself is a template triple with an empty first branch: a group `{ BIND(?s AS ?a) }` is evaluated on its own (SPARQL
 * semantics, as the fork does), so `?s` is unbound in it and the BIND gives nothing.
 */
function readQuery(g: Group): string {
    const p = g.p === undefined ? '?p' : `<${g.p}>`, root = g.kind === 'in' ? 's' : 'o';
    const values = g.kind === 'predicate' ? '' : `VALUES ?${g.kind === 'out' ? 's' : 'o'} { ${g.terms.map(ntriples).join(' ')} } `;
    const branches = ['{ }'];
    for (let d = 1; d <= CLOSURE_DEPTH; d++) branches.push(closureBranch(root, d));
    return `CONSTRUCT { ?s ${p} ?o . ?a ?q ?v } WHERE { ${values}?s ${p} ?o . ${branches.join(' UNION ')} }`;
}

/** The groups of the misses that name an IRI, a literal object or a predicate (not a blank node, not a triple term), at most VALUES_MAX terms each. */
function groupsOf(misses: Iterable<Miss>): Group[] {
    const byGroup = new Map<string, Group>();
    for (const m of misses) {
        if (m.kind !== 'predicate' && (m.term.termType === 'Triple' || m.term.termType === 'NamedNode' && m.term.value.startsWith(BLANK))) continue;
        const key = `${m.kind} ${m.p ?? '*'}`;
        const g = byGroup.get(key) ?? byGroup.set(key, { kind: m.kind, p: m.p, terms: [] }).get(key)!;
        if (m.kind !== 'predicate') g.terms.push(m.term as TermJSON);
    }
    return [...byGroup.values()].flatMap(g => {
        if (g.kind === 'predicate') return [g];
        const terms = [...new Map(g.terms.map(t => [nkey(t), t])).values()], out: Group[] = [];
        for (let i = 0; i < terms.length; i += VALUES_MAX) out.push({ ...g, terms: terms.slice(i, i + VALUES_MAX) });
        return out;
    });
}

/**
 * Marks what the answer of a group covers: the VALUES terms by kind and predicate, and every blank subject of the answer (its closure came
 * with it). A predicate read has no closure under `?s`: a blank `?s` that is not also an object of the answer (a closure node) came with
 * one predicate only and stays uncovered.
 */
function cover(covered: Coverage, g: Group, answer: NQuad[]): void {
    if (g.kind === 'predicate') covered.predicates.add(g.p!);
    else for (const k of g.terms.map(nkey)) {
        if (g.kind === 'out') g.p === undefined ? covered.outAll.add(k) : covered.outP.add(`${k} ${g.p}`);
        else g.p === undefined ? covered.inAll.add(k) : covered.inP.add(`${k} ${g.p}`);
    }
    const objects = g.kind === 'predicate' ? new Set(answer.map(q => nkey(q.object))) : undefined;
    for (const q of answer) {
        const k = nkey(q.subject);
        if (q.subject.value.startsWith(BLANK) && (!objects || objects.has(k))) { covered.outAll.add(k); covered.inAll.add(k); }
    }
}

/** A placed term or a term the caller asks about, as the IRIs to read around: an IRI, or the IRI ends of a statement. */
function iris(t: NTerm): string[] {
    if (t.termType === 'Triple') return [...iris(t.subject), ...iris(t.object)];
    return t.termType === 'NamedNode' ? [t.value] : [];
}

const IRI = /^[^\s<>"{}|^`\\]+$/;

/** A term the derivation can give a figure: an IRI that is not a blank node, or a statement. A placed blank node or literal has none; the join reports it. */
const figurable = (t: NTerm) => t.termType === 'Triple' || t.termType === 'NamedNode' && IRI.test(t.value) && !t.value.startsWith(BLANK);

/** The figures of a view, its placements and their join, and the number of index reads that the prefetch did not cover. */
export type PrefetchedFigures = ViewFigures & { misses: number };

/** One prefetch of a view: `view` the view quads of the server; `figures` the figures of the view with the given view quads. */
export interface FiguresPrefetch {
    view: Quad[];
    /**
     * Synchronous: the figures of the view when its quads are `view` (the quads of the server or a copy changed in memory), for the placed
     * terms and `also`. A statement of the server's view quads that `view` does not have is not in the index.
     */
    figures(view: Iterable<Quad>, also?: NTerm[]): PrefetchedFigures;
}

const tripleOf = (q: NQuad) => `${nkey(q.subject)} ${q.predicate} ${nkey(q.object)}`;

/**
 * The figures of a view from one prefetch, with `deriveFigures` unchanged (the old viewFiguresOf in catenary/rdf/notations.ts, `keep` false).
 * The prefetch: (a) the view quads (every statement of `viewFile`); (b) the shapes closure of `shapes`; (c) the statements of the placed terms and `also`; (d) rdfs:subClassOf
 * over `modelFiles`; (e) rounds of bounded queries for the reads that the derivation misses, blank nodes with the IRI that reaches them.
 */
export async function viewFiguresOf(port: ModelPort, viewIri: string, viewFile: string, shapes: ShapesModelRecords, modelFiles: string[], also: NTerm[] = []): Promise<PrefetchedFigures> {
    const prefetch = await prefetchFigures(port, viewIri, viewFile, shapes, modelFiles, also);
    return prefetch.figures(prefetch.view, also);
}

/** At most this many rounds of miss-driven queries. */
const MAX_ROUNDS = 16;

/**
 * The prefetch of viewFiguresOf, read before a command: `reach` are terms that the command can place (their statements are read as those
 * of the placed terms; they are in the scope of a derivation only when they are placed or the reader asks for them).
 */
export async function prefetchFigures(port: ModelPort, viewIri: string, viewFile: string, shapes: ShapesModelRecords, modelFiles: string[], reach: NTerm[] = []): Promise<FiguresPrefetch> {
    const notes = readNotations();
    const [view, subclasses] = await Promise.all([
        port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [viewFile]),
        port.construct(SUBCLASSES, modelFiles)
    ]);
    const viewQuads = nquads(view);
    const placed = placementsOf(new TripleIndex(viewQuads), viewIri);
    // As the old viewFiguresOf: a placement of another term (a statement with a literal, a blank node) has no figure; the join reports it.
    const scope = [...[...placed.keys()].map(keyTerm), ...reach].filter(figurable);

    const covered: Coverage = { outAll: new Set(), outP: new Set(), inAll: new Set(), inP: new Set(), predicates: new Set([SUBCLASS]) };
    // The closure holds every sh: statement of the model files without the manifest (shapePart starts at each subject with one), and the
    // statements of its subjects in the documents where they are shapes.
    const closure = nquads(shapes.closure);
    for (const q of closure) {
        covered.outAll.add(nkey(q.subject));
        if (q.predicate.startsWith(NS.sh)) covered.predicates.add(q.predicate);
    }
    const prefetched = [...closure, ...nquads(subclasses)], have = new Set(prefetched.map(tripleOf));

    // (c) The statements of the scope terms (the IRI ends of a statement) as subject and object, read in the first round.
    const ends = [...new Set(scope.flatMap(iris))].filter(v => !v.startsWith(BLANK)).map(v => ({ termType: 'NamedNode' as const, value: v }));
    let seed = groupsOf(ends.flatMap(term => [{ kind: 'out' as const, term }, { kind: 'in' as const, term }]));
    for (const t of ends) { covered.outAll.add(nkey(t)); covered.inAll.add(nkey(t)); }

    for (let round = 0; ; round++) {
        const index = new PrefetchIndex([...viewQuads, ...prefetched], covered);
        viewFigures(index, notes, viewIri, deriveFigures(index, notes, viewIri, scope, new Map()));
        const groups = [...seed, ...groupsOf(index.missed.values())];
        seed = [];
        if (!groups.length) break;
        if (round === MAX_ROUNDS) { console.warn(`figures of ${viewIri}: ${index.missed.size} reads open after ${MAX_ROUNDS} rounds`); break; }
        const answers = await Promise.all(groups.map(async g => nquads(await port.construct(readQuery(g)))));
        let added = 0;
        groups.forEach((g, i) => {
            cover(covered, g, answers[i]);
            for (const q of answers[i]) if (!have.has(tripleOf(q))) { have.add(tripleOf(q)); prefetched.push(q); added++; }
        });
        if (!added) break;
    }

    const served = new Set(viewQuads.map(tripleOf));
    return {
        view,
        figures(now, also = []) {
            const current = nquads(now), kept = new Set(current.map(tripleOf));
            // The view statements can also be in (c) and (e) (a read of the view IRI): a statement that left the view leaves the index.
            const gone = new Set([...served].filter(k => !kept.has(k)));
            const index = new PrefetchIndex([...current, ...gone.size ? prefetched.filter(q => !gone.has(tripleOf(q))) : prefetched], covered);
            const terms = [...[...placementsOf(new TripleIndex(current), viewIri).keys()].map(keyTerm), ...also].filter(figurable);
            const derivation = deriveFigures(index, notes, viewIri, terms, new Map());
            const result = viewFigures(index, notes, viewIri, derivation);
            return { ...result, misses: index.missed.size };
        }
    };
}
