// The notation figures of a view from turtle/query answers, with prefetch state reusable between draws.
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


/**
 * What the prefetch read completely (nkey): every statement of a subject (`outAll`) or an object (`inAll`), of a subject and predicate (`outP`),
 * of an object and predicate (`inP`), of a predicate. `read`: the IRIs (value) whose statements as subject in every document, and the rdf:type
 * and rdfs:label of their objects, came from the server (the reads of viewDocOf; `outAll` of a shape subject can come from the closure only).
 */
interface Coverage {
    outAll: Set<string>; outP: Set<string>; inAll: Set<string>; inP: Set<string>; predicates: Set<string>; read: Set<string>;
}

const emptyCoverage = (): Coverage => ({ outAll: new Set(), outP: new Set(), inAll: new Set(), inP: new Set(), predicates: new Set(), read: new Set() });

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
const VALUES_MAX = 500;

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

/**
 * A group of misses that one query reads: the same kind and predicate; `terms` the subjects or objects (none for a predicate read).
 * `objects`: the rdf:type and rdfs:label statements of the objects of `terms` (the known-object test of viewDocOf).
 */
interface Group { kind: Miss['kind'] | 'objects'; p?: string; terms: TermJSON[] }

const TYPE_LABEL = `VALUES ?p { <${RDF('type')}> <${NS.rdfs}label> }`;

/** One query per round (or VALUES chunk), with shared object closure and incoming-subject closure. */
function readQuery(groups: Group[]): string {
    const reads = groups.map(g => {
        if (g.kind === 'objects') return `{ VALUES ?k { ${g.terms.map(ntriples).join(' ')} } ?k ?kp ?s . ${TYPE_LABEL} ?s ?p ?o }`;
        const values = g.kind === 'predicate' ? '' : `VALUES ?${g.kind === 'out' ? 's' : 'o'} { ${g.terms.map(ntriples).join(' ')} } `;
        const predicate = g.p === undefined ? '' : `VALUES ?p { <${g.p}> } `;
        return `{ ${values}${predicate}?s ?p ?o ${g.kind === 'in' ? 'BIND(?s AS ?incoming)' : ''} }`;
    });
    // The empty branch keeps the matched statement even when its object has no blank-node closure.
    const branches = ['{ }'];
    for (let d = 1; d <= CLOSURE_DEPTH; d++) {
        branches.push(closureBranch('o', d));
        if (groups.some(g => g.kind === 'in')) branches.push(closureBranch('incoming', d));
    }
    return `CONSTRUCT { ?s ?p ?o . ?a ?q ?v } WHERE { { ${reads.join(' UNION ')} } ${branches.join(' UNION ')} }`;
}

/** Split only oversized VALUES lists; groups with at most VALUES_MAX terms share one query. */
function batchesOf(groups: Group[]): Group[][] {
    const count = Math.max(1, ...groups.map(g => Math.ceil(g.terms.length / VALUES_MAX)));
    return Array.from({ length: count }, (_, i) => groups.flatMap(g => {
        if (g.kind === 'predicate') return i === 0 ? [g] : [];
        const terms = g.terms.slice(i * VALUES_MAX, (i + 1) * VALUES_MAX);
        return terms.length ? [{ ...g, terms }] : [];
    }));
}

/** The groups of the misses that name an IRI, a literal object or a predicate (not a blank node, not a triple term). */
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
        return [{ ...g, terms: [...new Map(g.terms.map(t => [nkey(t), t])).values()] }];
    });
}

/**
 * Marks the VALUES terms by kind and predicate, blank subjects reached as objects, and incoming blank roots.
 * Other blank subjects came with one statement only and stay uncovered.
 */
function cover(covered: Coverage, g: Group, answer: NQuad[]): void {
    if (g.kind === 'predicate') covered.predicates.add(g.p!);
    else if (g.kind === 'objects') for (const t of g.terms) covered.read.add(t.value);
    else for (const k of g.terms.map(nkey)) {
        if (g.kind === 'out') g.p === undefined ? covered.outAll.add(k) : covered.outP.add(`${k} ${g.p}`);
        else g.p === undefined ? covered.inAll.add(k) : covered.inP.add(`${k} ${g.p}`);
    }
    const objects = new Set(answer.map(q => nkey(q.object)));
    const terms = new Set(g.terms.map(nkey));
    const incoming = new Set(g.kind === 'in' ? answer.filter(q => terms.has(nkey(q.object)) && (g.p === undefined || q.predicate === g.p)).map(q => nkey(q.subject)) : []);
    for (const q of answer) {
        const k = nkey(q.subject);
        if (q.subject.value.startsWith(BLANK) && (objects.has(k) || incoming.has(k))) { covered.outAll.add(k); covered.inAll.add(k); }
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

/** Statements and coverage retained for one view within one model generation. View statements are read fresh on each draw. */
export interface KeptPrefetch {
    /** Model records from the completed draw; never view geometry. */
    records?: Pick<import('../catenary/model/doc').Doc, 'instances' | 'relations'>;
    quads: NQuad[];
    covered: Coverage;
    view: NQuad[];
}

/** One prefetch of a view: `view` the view quads of the server; `figures` the figures of the view with the given view quads. */
export interface FiguresPrefetch {
    view: Quad[];
    kept: KeptPrefetch;
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
export async function viewFiguresOf(port: ModelPort, viewIri: string, viewFile: string, shapes: ShapesModelRecords, modelFiles: string[], also: NTerm[] = [], kept?: KeptPrefetch, reads: string[] = []): Promise<PrefetchedFigures & { kept: KeptPrefetch; view: Quad[] }> {
    const prefetch = await prefetchFigures(port, viewIri, viewFile, shapes, modelFiles, also, kept, reads);
    return { ...prefetch.figures(prefetch.view, also), kept: prefetch.kept, view: prefetch.view };
}

/** Derive against retained facts and current view text without a port or a request. */
export function figuresFromText(viewIri: string, now: Iterable<Quad>, kept: KeptPrefetch, also: NTerm[] = []): PrefetchedFigures {
    const current = nquads(now), present = new Set(current.map(tripleOf));
    const gone = new Set(kept.view.map(tripleOf).filter(k => !present.has(k)));
    const index = new PrefetchIndex([...current, ...kept.quads.filter(q => !gone.has(tripleOf(q)))], kept.covered);
    const terms = [...[...placementsOf(new TripleIndex(current), viewIri).keys()].map(keyTerm), ...also].filter(figurable);
    const notes = readNotations();
    return { ...viewFigures(index, notes, viewIri, deriveFigures(index, notes, viewIri, terms, new Map())), misses: index.missed.size };
}

/** Empty retained index for a view's first text draw. */
export function emptyPrefetch(shapes?: ShapesModelRecords): KeptPrefetch {
    return { quads: nquads(shapes?.closure ?? []), view: [], covered: emptyCoverage() };
}

/** At most this many rounds of miss-driven queries. */
const MAX_ROUNDS = 16;

/**
 * The prefetch of viewFiguresOf, read before a command: `reach` are terms that the command can place (their statements are read as those
 * of the placed terms; they are in the scope of a derivation only when they are placed or the reader asks for them). `reads`: IRIs whose
 * statements as subject and the rdf:type and rdfs:label of their objects the first round reads (the misses of viewDocOf; `covered.read`).
 */
export async function prefetchFigures(port: ModelPort, viewIri: string, viewFile: string, shapes: ShapesModelRecords, modelFiles: string[], reach: NTerm[] = [], kept?: KeptPrefetch, reads: string[] = []): Promise<FiguresPrefetch> {
    const notes = readNotations();
    const [view, subclasses] = await Promise.all([
        port.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', [viewFile]),
        kept ? Promise.resolve([]) : port.construct(SUBCLASSES, modelFiles)
    ]);
    const viewQuads = nquads(view);
    const placed = placementsOf(new TripleIndex(viewQuads), viewIri);
    // As the old viewFiguresOf: a placement of another term (a statement with a literal, a blank node) has no figure; the join reports it.
    const scope = [...[...placed.keys()].map(keyTerm), ...reach].filter(figurable);

    // Copy the coverage: concurrent draws must not mutate the state they started from.
    const covered: Coverage = kept ? {
        outAll: new Set(kept.covered.outAll), outP: new Set(kept.covered.outP),
        inAll: new Set(kept.covered.inAll), inP: new Set(kept.covered.inP), predicates: new Set(kept.covered.predicates), read: new Set(kept.covered.read)
    } : { ...emptyCoverage(), predicates: new Set([SUBCLASS]) };
    // The closure holds every sh: statement of the model files without the manifest (shapePart starts at each subject with one), and the
    // statements of its subjects in the documents where they are shapes.
    const closure = kept ? [] : nquads(shapes.closure);
    for (const q of closure) {
        covered.outAll.add(nkey(q.subject));
        if (q.predicate.startsWith(NS.sh)) covered.predicates.add(q.predicate);
    }
    const served = new Set(viewQuads.map(tripleOf));
    const gone = new Set(kept?.view.map(tripleOf).filter(k => !served.has(k)));
    const prefetched = kept ? kept.quads.filter(q => !gone.has(tripleOf(q))) : [...closure, ...nquads(subclasses)];
    const have = new Set(prefetched.map(tripleOf));

    // (c) The statements of the scope terms (the IRI ends of a statement) as subject and object, read in the first round.
    const ends = [...new Set([viewIri, ...scope.flatMap(iris)])].filter(v => !v.startsWith(BLANK)).map(v => ({ termType: 'NamedNode' as const, value: v }));
    // The reads of viewDocOf: every statement of the IRI as subject (also of a shape subject: the closure has its shapes documents only) and
    // the types and labels of its objects, in the same round.
    const docReads = [...new Set(reads)].filter(v => !v.startsWith(BLANK) && !covered.read.has(v)).map(v => ({ termType: 'NamedNode' as const, value: v }));
    const outs = new Set(docReads.map(t => t.value));
    let seed: Group[] = [...groupsOf([
        ...ends.flatMap(term => [
            ...covered.outAll.has(nkey(term)) || outs.has(term.value) ? [] : [{ kind: 'out' as const, term }],
            ...covered.inAll.has(nkey(term)) ? [] : [{ kind: 'in' as const, term }]
        ]),
        ...docReads.map(term => ({ kind: 'out' as const, term }))
    ]), ...docReads.length ? [{ kind: 'objects' as const, terms: docReads }] : []];
    for (const t of [...ends, ...docReads]) covered.outAll.add(nkey(t));
    for (const t of ends) covered.inAll.add(nkey(t));

    for (let round = 0; ; round++) {
        const index = new PrefetchIndex([...viewQuads, ...prefetched], covered);
        viewFigures(index, notes, viewIri, deriveFigures(index, notes, viewIri, scope, new Map()));
        const groups = [...seed, ...groupsOf(index.missed.values())];
        seed = [];
        if (!groups.length) break;
        if (round === MAX_ROUNDS) { console.warn(`figures of ${viewIri}: ${index.missed.size} reads open after ${MAX_ROUNDS} rounds`); break; }
        const batches = batchesOf(groups);
        const answers = await Promise.all(batches.map(async batch => nquads(await port.construct(readQuery(batch)))));
        let added = 0;
        batches.forEach((batch, i) => {
            for (const g of batch) cover(covered, g, answers[i]);
            for (const q of answers[i]) if (!have.has(tripleOf(q))) { have.add(tripleOf(q)); prefetched.push(q); added++; }
        });
        if (!added) break;
    }

    return {
        view,
        kept: { quads: prefetched.filter(q => !served.has(tripleOf(q))), covered, view: viewQuads },
        figures: (now, also = []) => figuresFromText(viewIri, now, { quads: prefetched, covered, view: viewQuads }, also)
    };
}
