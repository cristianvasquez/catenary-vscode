// Derive class, field and link metadata from RDFS domains and ranges; adapted from Catenary packages/rdfs/src/domain-range.ts.
import type { FieldRule } from '../contracts/fields';
import type { LinkRule } from '../contracts/links';
import type { PaletteClass } from '../contracts/palette';
import { OWL, QueryTerm, RDF, RDFS, SH, XSD, iri } from '../contracts/query';


/** What the objects of a predicate are: instances of a class, literals (of a datatype), or any value (a literal or a resource). */
type RdfsRange = { kind: 'class'; iri: string; subclasses?: string[] } | { kind: 'literal'; datatype?: string } | { kind: 'any' };

/** One domain, predicate and range. Domains are expanded to the written subclasses; a class range names them (`subclasses`). */
interface RdfsRule { domain: string; predicate: string; name?: string; description?: string; range: RdfsRange }

interface RdfsRules { rules: RdfsRule[]; classes: Record<string, { name?: string; description?: string }> }


const SKOS = 'http://www.w3.org/2004/02/skos/core#';

const PREFIXES = `PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}> PREFIX skos: <${SKOS}>`;


/** Built-in vocabularies: their predicates and classes give no rules (the editor handles them itself). */
const BUILT_IN = [RDF, RDFS, OWL, SH, SKOS];

/** Ranges that accept any value: a literal or a resource. */
const ANY = new Set([RDFS + 'Resource', OWL + 'Thing']);

/** Literal ranges outside the XSD namespace. */
const LITERALS = new Set([RDF + 'langString', RDF + 'HTML', RDF + 'XMLLiteral', RDF + 'JSON', RDF + 'PlainLiteral']);


const builtIn = (iri: string) => BUILT_IN.some(ns => iri.startsWith(ns));


const add = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (!list) m.set(k, [v]);
    else if (!list.includes(v)) list.push(v);
};


/** A class and its written subclasses at any depth, the class first. A subclass cycle ends. */
function withSubclasses(subs: Map<string, string[]>, c: string): string[] {
    const out: string[] = [];
    const visit = (x: string) => {
        if (out.includes(x)) return;
        out.push(x);
        (subs.get(x) ?? []).slice().sort().forEach(visit);
    };
    visit(c);
    return out;
}


/** The literals of `predicates` (a SPARQL path) of `subjects`. `graph`: wraps a pattern in the graphs to read. */
function textsQuery(graph: (pattern: string) => string, predicates: string, subjects: string[]): string {
    return `${PREFIXES} SELECT ?s ?v ?lang WHERE {
        VALUES ?s { ${subjects.map(iri).join(' ')} }
        ${graph(`?s ${predicates} ?v`)} FILTER (isLiteral(?v)) BIND (LANG(?v) AS ?lang)
    }`;
}


/** For each subject of `rows` (textsQuery): a plain or English literal first, then the others in value order. */
function pickTexts(rows: readonly Record<string, QueryTerm>[]): Map<string, string> {
    const out = new Map<string, string>();
    const rank = (r: typeof rows[number]) => (!r.lang?.value || r.lang.value.startsWith('en') ? 0 : 1);
    for (const r of [...rows].sort((a, b) => rank(a) - rank(b) || a.v.value.localeCompare(b.v.value))) if (!out.has(r.s.value)) out.set(r.s.value, r.v.value);
    return out;
}


/** The range of one `rdfs:range` value: any value, any literal, a literal of a datatype, or a class. */
function rangeOf(r: string, datatypes: Set<string>): RdfsRange {
    if (ANY.has(r)) return { kind: 'any' };
    if (r === RDFS + 'Literal') return { kind: 'literal' };
    if (r.startsWith(XSD) || LITERALS.has(r) || datatypes.has(r)) return { kind: 'literal', datatype: r };
    return { kind: 'class', iri: r };
}


const PAIRS = { domain: '?a rdfs:domain ?b', range: '?a rdfs:range ?b', subClassOf: '?a rdfs:subClassOf ?b' } as const;

const NAMES = 'rdfs:label|skos:prefLabel', COMMENTS = 'rdfs:comment';

const pairsQuery = (graph: (pattern: string) => string, pattern: string) => `${PREFIXES} SELECT DISTINCT ?a ?b WHERE { ${graph(pattern)} FILTER (isIRI(?a) && isIRI(?b)) }`;

const datatypesQuery = (graph: (pattern: string) => string) => `${PREFIXES} SELECT DISTINCT ?t WHERE { ${graph('?t rdf:type rdfs:Datatype')} FILTER (isIRI(?t)) }`;


type Rows = readonly Record<string, QueryTerm>[];

/** What the rules read: the IRI pairs of rdfs:domain, rdfs:range, rdfs:subClassOf, the rdfs:Datatype IRIs, and the texts of IRIs. */
interface RdfsFacts {
    domain: Rows;
    range: Rows;
    subClassOf: Rows;
    datatypes: string[];
    /** `predicates`: NAMES or COMMENTS. */
    texts(predicates: string, subjects: string[]): Map<string, string>;
}


/**
 * The facts of the rules from `select`, which reads the documents to query (no GRAPH pattern). Undefined: no rdfs:domain pair. The texts
 * are read once for every IRI of the pairs: the rules ask for the texts of their predicates and classes, and each of these is an IRI of a pair.
 */
async function selectFacts(select: (query: string) => Promise<Rows>): Promise<RdfsFacts | undefined> {
    const plain = (pattern: string) => pattern;
    const domain = await select(pairsQuery(plain, PAIRS.domain));
    if (!domain.length) return undefined;
    const [range, subClassOf, datatypes] = await Promise.all([select(pairsQuery(plain, PAIRS.range)), select(pairsQuery(plain, PAIRS.subClassOf)), select(datatypesQuery(plain))]);
    const iris = [...new Set([domain, range, subClassOf].flatMap(rows => rows.flatMap(r => [r.a.value, r.b.value])))].sort();
    const [names, comments] = await Promise.all([NAMES, COMMENTS].map(async p => pickTexts(await select(textsQuery(plain, p, iris)))));
    const read = new Map([[NAMES, names], [COMMENTS, comments]]);
    return {
        domain, range, subClassOf, datatypes: datatypes.map(r => r.t.value),
        texts: (predicates, subjects) => new Map(subjects.flatMap(s => { const v = read.get(predicates)?.get(s); return v === undefined ? [] : [[s, v] as const]; }))
    };
}


/** The rules of the written rdfs:domain and rdfs:range statements of `facts`. */
function rdfsRules(facts: RdfsFacts | undefined): RdfsRules {
    const domains = new Map<string, string[]>(), ranges = new Map<string, string[]>(), subs = new Map<string, string[]>();
    for (const r of facts?.domain ?? []) if (!builtIn(r.a.value) && !builtIn(r.b.value)) add(domains, r.a.value, r.b.value);
    if (!facts || !domains.size) return { rules: [], classes: {} };
    for (const r of facts.range) if (domains.has(r.a.value)) add(ranges, r.a.value, r.b.value);
    for (const r of facts.subClassOf) if (r.a.value !== r.b.value) add(subs, r.b.value, r.a.value);
    const datatypes = new Set(facts.datatypes);

    const predicates = [...domains.keys()].sort();
    const names = facts.texts(NAMES, predicates), comments = facts.texts(COMMENTS, predicates);
    const rules: RdfsRule[] = [], seen = new Set<string>();
    // The written subclasses of each class range: one shared list.
    const below = new Map<string, string[]>();
    for (const p of predicates) {
        const objects = (ranges.get(p) ?? []).slice().sort().map(r => rangeOf(r, datatypes));
        // A class range also admits the instances of its subclasses: the link names them, so one link covers the whole tree.
        const expanded: RdfsRange[] = objects.length ? objects.map((r): RdfsRange => {
            if (r.kind !== 'class') return r;
            let subclasses = below.get(r.iri);
            if (!subclasses) below.set(r.iri, subclasses = withSubclasses(subs, r.iri).slice(1));
            return subclasses.length ? { ...r, subclasses } : r;
        }) : [{ kind: 'any' }];
        const own = { predicate: p, ...(names.has(p) ? { name: names.get(p) } : {}), ...(comments.has(p) ? { description: comments.get(p) } : {}) };
        const classes = [...new Set(domains.get(p)!.slice().sort().flatMap(d => withSubclasses(subs, d)))];
        for (const domain of classes) for (const range of expanded) {
            const key = [domain, p, range.kind, range.kind === 'class' ? range.iri : range.kind === 'literal' ? range.datatype ?? '' : ''].join(' ');
            if (!seen.has(key)) rules.push({ domain, ...own, range });
            seen.add(key);
        }
    }

    const classIris = [...new Set(rules.flatMap(r => [r.domain, ...(r.range.kind === 'class' ? [r.range.iri, ...r.range.subclasses ?? []] : [])]))].sort();
    const classNames = facts.texts(NAMES, classIris), classComments = facts.texts(COMMENTS, classIris);
    const classes: RdfsRules['classes'] = {};
    for (const c of classIris) classes[c] = { ...(classNames.has(c) ? { name: classNames.get(c) } : {}), ...(classComments.has(c) ? { description: classComments.get(c) } : {}) };
    return { rules, classes };
}



/** The domains of the rules, with their written labels and descriptions; in IRI order. */
function classes({ rules, classes }: RdfsRules): PaletteClass[] {
    return [...new Set(rules.map(r => r.domain))].sort().map(iri => ({ iri, ...classes[iri] }));
}


const own = (r: RdfsRule) => ({ domain: r.domain, predicate: r.predicate, ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}) });


/** A class range: a link to that class. Any value: a link to any resource (and a field). */
function links({ rules }: RdfsRules): LinkRule[] {
    return rules.flatMap(r => r.range.kind === 'class' ? [{ ...own(r), target: r.range.iri, ...(r.range.subclasses ? { targetSubclasses: r.range.subclasses } : {}) }] : r.range.kind === 'any' ? [own(r)] : []);
}


/** Literal ranges and any value: one field for each domain and predicate, with a datatype only when all its ranges have the same one. */
function fields({ rules }: RdfsRules): FieldRule[] {
    const out = new Map<string, { field: FieldRule; datatypes: Set<string | undefined> }>();
    for (const r of rules) {
        if (r.range.kind === 'class') continue;
        const k = r.domain + ' ' + r.predicate;
        const entry = out.get(k) ?? { field: own(r), datatypes: new Set() };
        out.set(k, entry);
        entry.datatypes.add(r.range.kind === 'literal' ? r.range.datatype : undefined);
    }
    return [...out.values()].map(({ field, datatypes }) => {
        const [datatype] = datatypes;
        return { ...field, ...(datatypes.size === 1 && datatype ? { datatype } : {}), iri: false };
    });
}


/** The classes, links and fields of the RDFS rules, from the answers of `select` over the documents to read (no GRAPH pattern). */
export async function rdfsAuthoring(select: (query: string) => Promise<Rows>): Promise<{ classes: PaletteClass[]; links: LinkRule[]; fields: FieldRule[] }> {
    const rules = rdfsRules(await selectFacts(select));
    return { classes: classes(rules), links: links(rules), fields: fields(rules) };
}
