// The Doc of one view (readView of view-read.ts) from the view text and the kept answer of the view; it sends no query. View labels: viewGraphsOf.
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { Parser } from 'n3';
import { pathToFileURL } from 'node:url';
import { type Doc, emptyDoc } from '../catenary/model/doc';
import { pickLabel } from '../catenary/model/labels';
import { NS, publishedIri } from '../catenary/model/terms';
import { UNION_GRAPH } from '../catenary/rdf/files';
import { elementId, elementTerm, relationId, relationTriple } from '../catenary/rdf/ids';
import { readLegacy } from '../catenary/rdf/loader';
import { type Plain, type Resource, type Statements, cardIdsOf, first, instanceRecords, key, projectView } from '../catenary/rdf/records';
import { rdf, termKey } from '../catenary/rdf/terms';
import { P, SKOS_MEMBERSHIP, SKOS_TYPES, labelFromIri, labelLiterals } from '../catenary/rdf/vocabulary';
import type { NQuad, NTerm } from '../catenary/model/notation-graph';
import type { ModelPort, Row } from '../model/port';
import type { ModelContext } from './diagram';
import type { KeptPrefetch } from './figures';
import { inShapesOf } from './neighbors';
import type { ShapesModelRecords } from './shapes';

/** `oview:`: the legacy namespace of view: (LEGACY_NAMESPACES of model/terms.ts). The view queries match both; readLegacy maps the answers. */
const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX oview: <osg://vocab/view#> PREFIX skos: <${NS.skos}>`;

const MARKS = [['Frame', 'groups', NS.rdfs + 'label'], ['Note', 'notes', NS.view + 'text'], ['FileRef', 'fileReferences', NS.view + 'file'], ['EntityGroup', 'collections', NS.view + 'member']] as const;

/** The content property of a mark in the Doc (Resource values). */
const MARK_VALUE: Record<string, string> = { [NS.rdfs + 'label']: 'label', [NS.view + 'text']: 'text', [NS.view + 'file']: 'file', [NS.view + 'member']: 'member' };

const PLACEMENT_PROPS = ['element', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide', 'vertices'];

/** The prefix of the IRI that the port gives for a blank node (port.ts, toEngine of model/nquads.ts). */
const BLANK = 'urn:skolem:blank:';

const TYPE = P.type.value, LABEL = P.label.value, ELEMENT = NS.view + 'element', REIFIES = NS.rdf + 'reifies', ARROW = NS.view + 'arrow', MEMBER = NS.view + 'member';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });

/** The view:View subjects of a view file, their labels and their view:description. */
const VIEW_SUBJECTS = `${PREFIXES} SELECT ?v ?l ?d WHERE { ?v a ?vt FILTER (?vt IN (view:View, oview:View))
    OPTIONAL { ?v rdfs:label ?l } OPTIONAL { ?v view:description|oview:description ?d } }`;

/** The rows with their terms in the published namespaces (readLegacy over the quads of `?s ?p ?o`); the other variables unchanged. */
export function legacyRows<R extends Row>(rows: R[]): R[] {
    const { quads, changed } = readLegacy(rows.map(r => rdf.quad(r.s as Quad['subject'], r.p as Quad['predicate'], r.o as Quad['object'])));
    return changed ? rows.map((r, i) => ({ ...r, s: quads[i].subject, p: quads[i].predicate, o: quads[i].object })) : rows;
}

export type ViewGraph = { subjects: Map<string, { v: Term; labels: Term[] }>; description?: Term };

/** The views by IRI: for each view file of `views` (view IRI → file path), its view:View subject that is the view IRI, read with `files: [file]`. */
export async function viewGraphsOf(port: ModelPort, views: Map<string, string>): Promise<Map<string, ViewGraph>> {
    const out = new Map<string, ViewGraph>();
    await Promise.all([...views].map(async ([iri, file]) => {
        const rows = (await port.select(VIEW_SUBJECTS, [file])).filter(r => r.v.termType === 'NamedNode' && r.v.value === iri);
        if (!rows.length) return;
        const v = { v: rows[0].v, labels: [] as Term[] }, e: ViewGraph = { subjects: new Map([[termKey(v.v), v]]) };
        for (const r of rows) {
            if (r.l && !v.labels.some(x => x.equals(r.l))) v.labels.push(r.l);
            if (r.d && !e.description) e.description = r.d;
        }
        out.set(iri, e);
    }));
    return out;
}

/** The label of a view graph: the first view:View subject; its rdfs:label (pickLabel), else from the IRI. */
function viewLabel(graph: ViewGraph, language?: string): string {
    const subject = [...graph.subjects.values()].sort((a, b) => cmp(a.v.value, b.v.value))[0];
    return pickLabel(labelLiterals(p => p === LABEL ? subject.labels : []), language) ?? labelFromIri(subject.v.value);
}

/** Label of every view (view id → label), as viewLabels of view-read.ts. `views`: view IRI → file path (ModelContext.views). */
export async function viewLabelsOf(port: ModelPort, views: Map<string, string>, language?: string, cached?: Map<string, ViewGraph>): Promise<Record<string, string>> {
    const graphs = cached ?? await viewGraphsOf(port, views);
    return Object.fromEntries([...graphs].filter(([iri]) => views.has(iri)).sort((a, b) => cmp(a[0], b[0])).map(([graph, e]) => [elementId(rdf.namedNode(graph)), viewLabel(e, language)]));
}

/** Subject in the view graph → predicate → objects, in answer order. */
type ViewQuads = Map<string, { s: Term; props: Map<string, Term[]> }>;

function viewQuadsOf(rows: Row[]): ViewQuads {
    const out: ViewQuads = new Map();
    for (const { s, p, o } of rows) {
        let e = out.get(s.value);
        if (!e) out.set(s.value, e = { s, props: new Map() });
        const os = e.props.get(p.value);
        if (!os) e.props.set(p.value, [o]);
        else if (!os.some(x => x.equals(o))) os.push(o);
    }
    return out;
}

/** An engine term of the answer as an RDF/JS term. */
function rdfTerm(t: NTerm): Term {
    if (t.termType === 'Triple') return rdf.quad(rdfTerm(t.subject) as Quad['subject'], rdf.namedNode(t.predicate.value), rdfTerm(t.object) as Quad['object']);
    if (t.termType === 'NamedNode') return rdf.namedNode(t.value);
    return rdf.literal(t.value, t.language || (t.datatype ? rdf.namedNode(t.datatype) : undefined));
}

const statementKey = (r: Row) => `${termKey(r.s)} ${termKey(r.p)} ${termKey(r.o)}`;

/** The statements of the shapes closure (statementKey, published namespaces), per shapes model. */
const closureKeys = new WeakMap<ShapesModelRecords, Set<string>>();

function closureOf(shapes: ShapesModelRecords): Set<string> {
    let keys = closureKeys.get(shapes);
    if (!keys) closureKeys.set(shapes, keys = new Set(readLegacy(shapes.closure).quads.map(q => statementKey({ s: q.subject, p: q.predicate, o: q.object }))));
    return keys;
}

/** The statements of the answer by subject (published namespaces, graphs dropped). */
function answerRows(quads: NQuad[]): Map<string, Row[]> {
    const out = new Map<string, Row[]>();
    for (const r of legacyRows(quads.map(q => ({ s: rdfTerm(q.subject), p: rdf.namedNode(q.predicate), o: rdfTerm(q.object) })))) {
        (out.get(r.s.value) ?? out.set(r.s.value, []).get(r.s.value)!).push(r);
    }
    return out;
}

export interface ViewDocOptions {
    /** Only these placements and what they need (scopedDoc). */
    elements?: string[];
    /** Receives what the view cannot show. */
    warnings?: string[];
    /** Receives the IRIs whose statements the answer has not read (`covered.read`): prefetchFigures reads them (`reads`), then the reader runs again. */
    misses?: Set<string>;
}

/**
 * The Doc of the view `viewIri` (readView of view-read.ts): the view, the instances it places (and the SKOS vocabulary when it shows shapes),
 * their relations, and the views it names. It sends no query: the view statements come from `view` (the view text, or its quads), the model
 * statements from `answer` (the kept answer of the view, KeptPrefetch); what the answer has not read goes to `options.misses`. A placed
 * IRI without statements gets a box from the IRI (or, for a miss, from `answer.records`). An empty Doc when `viewIri` is not a view of `ctx.views`.
 * The labels of the other views come from `ctx.viewLabels`.
 */
export function viewDocOf(ctx: Pick<ModelContext, 'views' | 'shapes' | 'manifest' | 'viewLabels'>, viewIri: string, view: string | Quad[], answer: KeptPrefetch, options: ViewDocOptions = {}): Doc {
    const { elements, warnings = [], misses = new Set<string>() } = options;
    const { shapes, views } = ctx, language = ctx.manifest.language, model = shapes.index.model;
    const viewFile = views.get(viewIri);
    if (!viewFile) return emptyDoc();
    const quads = typeof view === 'string' ? new Parser({ format: 'application/trig', baseIRI: pathToFileURL(viewFile).href }).parse(view) : view;
    const vq = viewQuadsOf(readLegacy(quads).quads.map(q => ({ s: q.subject, p: q.predicate, o: q.object })));
    const objects = (s: string, p: string): Term[] => vq.get(s)?.props.get(p) ?? [];
    const own = vq.get(viewIri);
    if (!own || own.s.termType !== 'NamedNode' || !objects(viewIri, TYPE).some(t => t.value === NS.view + 'View')) return emptyDoc();
    const ownGraph: ViewGraph = { subjects: new Map([[termKey(own.s), { v: own.s, labels: objects(viewIri, LABEL) }]]) };
    const description = objects(viewIri, NS.view + 'description')[0];
    if (description) ownGraph.description = description;
    const viewGraphs = new Map(ctx.viewLabels);
    viewGraphs.set(viewIri, ownGraph);

    /** A shape subject of any document (the shows test, the object test of the statements filter). */
    const isShape = (t: Term) => shapes.shapeSubjects.has(termKey(t));
    const inShapes = inShapesOf(shapes), closure = closureOf(shapes);
    /** A statement of a shape subject in a document where it is a shape (the closure); its other statements are model statements. */
    const shapeRow = (r: Row) => closure.has(statementKey(r));
    const isViewType = (t: Term) => t.value.startsWith(NS.view);
    const isPlacement = (s: string) => objects(s, TYPE).some(t => t.value === NS.view + 'Placement');
    /** The placements of the view graph, or the placements among `scope`. */
    const placementsIn = (scope?: Set<string>) => [...vq.keys()].filter(s => isPlacement(s) && (!scope || scope.has(s))).sort(cmp);
    /** The marks among `subjects` (a subject of the view graph with a mark type). */
    const marksOf = (subjects: Iterable<string>) => [...new Set(subjects)].filter(s => MARKS.some(([t]) => objects(s, TYPE).some(o => o.value === NS.view + t)));
    const memberOf = (term: string) => [...vq.values()].filter(e => (e.props.get(MEMBER) ?? []).some(o => o.value === term)).map(e => e.s.value);

    // The model statements of the answer; a subject of a view file (a view, a mark, a placement) is not a model subject.
    const bySubject = answerRows(answer.quads);
    const viewSubjects = new Set([...vq.values()].filter(e => (e.props.get(TYPE) ?? []).some(isViewType)).map(e => e.s.value));
    for (const [s, rows] of bySubject) if (views.has(s) || rows.some(r => r.p.value === TYPE && isViewType(r.o))) {
        viewSubjects.add(s);
        bySubject.delete(s);
    }
    /** The statements of `iri` as subject; an IRI that the answer has not read is a miss. */
    const rowsOf = (iri: string): Row[] => {
        if (!iri.startsWith(BLANK) && !answer.covered.read.has(iri)) misses.add(iri);
        return bySubject.get(iri) ?? [];
    };

    const doc = emptyDoc();
    doc.shapes = model;
    const requested = new Set<string>();
    const placementIds = new Set<string>();
    const setsOfMember = new Map<string, string[]>();
    for (const set of Object.values(model.valueSets)) for (const m of set.members) setsOfMember.set(m.uri, [...setsOfMember.get(m.uri) ?? [], set.uri]);
    const add = (id: string) => {
        const part = model.properties[id] ?? model.constraints[id];
        const owner = part && model.nodeShapes[part.owner];
        const term = elementTerm(id);
        if (term) {
            requested.add(term.value);
            for (const set of setsOfMember.get(term.value) ?? []) requested.add(set);
            for (const c of memberOf(term.value)) requested.add(c);
        }
        if (owner) requested.add(owner.uri);
        if (part && 'uri' in part && part.uri) requested.add(part.uri);
        const triple = relationTriple(id);
        if (triple) { requested.add(triple.s.value); requested.add(triple.o.value); }
    };
    /** The placements (any subject with view:element) of each IRI in the view graph. */
    const placementsOf = (iris: Iterable<string>) => {
        const wanted = new Set(iris), out: string[] = [];
        for (const [s, e] of vq) if ((e.props.get(ELEMENT) ?? []).some(o => wanted.has(o.value))) out.push(s);
        return out;
    };
    if (elements) {
        const ids = [...new Set(elements)];
        const terms = new Map(ids.flatMap(id => { const t = elementTerm(id); return t ? [[id, t.value] as const] : []; }));
        const subjects = [...terms.values()].filter(t => vq.has(t));
        // The frames among the elements of these subjects (a frame mark in a view graph), with the geometry of the subject.
        const frameTerms = new Set(marksOf(subjects.flatMap(s => objects(s, ELEMENT).map(o => o.value))).filter(s => objects(s, TYPE).some(t => t.value === NS.view + 'Frame')));
        const number = (t: Term | undefined, fallback: number) => { const n = Number(t?.value ?? fallback); return isNaN(n) ? fallback : n; };
        const geometry = (s: string, p: string) => objects(s, NS.view + p)[0];
        const boxes = subjects.filter(s => objects(s, ELEMENT).some(o => frameTerms.has(o.value))).map(s => {
            const x = number(geometry(s, 'x'), 0), y = number(geometry(s, 'y'), 0);
            return [x, y, x + number(geometry(s, 'width'), 400), y + number(geometry(s, 'height'), 300)];
        });
        // The placements inside a frame: COALESCE of the old query, a value that is not a number fails the comparison.
        const at = (s: string, p: string, fallback: number) => { const t = geometry(s, p); return t ? Number(t.value) : fallback; };
        const inFrames = boxes.length ? [...new Set(placementsIn().filter(pl => {
            const x = at(pl, 'x', 0), y = at(pl, 'y', 0), x2 = x + at(pl, 'width', 640), y2 = y + at(pl, 'height', 320);
            return boxes.some(([fx, fy, fx2, fy2]) => x >= fx && y >= fy && x2 <= fx2 && y2 <= fy2);
        }).flatMap(pl => objects(pl, ELEMENT).map(e => elementId(e as NamedNode))))] : [];
        for (const id of ids) {
            add(id);
            const term = terms.get(id);
            if (term === undefined || !vq.has(term)) continue;
            placementIds.add(term);
            for (const o of objects(term, ELEMENT)) if (o.termType === 'NamedNode') add(elementId(o));
            for (const o of objects(term, REIFIES)) if (o.termType === 'Quad') for (const t of [o.subject, o.object]) if (t.termType === 'NamedNode') requested.add(t.value);
        }
        inFrames.forEach(add);
        placementsOf(requested).forEach(pl => placementIds.add(pl));
    }
    const scope = elements ? placementIds : undefined;
    const placements = placementsIn(scope);
    // Placed elements, then the members of the entity groups among them (in a view graph).
    const placementElements = [...new Set(placements.flatMap(pl => objects(pl, ELEMENT).map(o => o.value)))];
    const groups = marksOf(placementElements).filter(s => objects(s, TYPE).some(t => t.value === NS.view + 'EntityGroup'));
    const placed = new Set(placementElements);
    for (const g of groups) for (const m of objects(g, MEMBER)) placed.add(m.value);
    if (elements) requested.forEach(e => placed.add(e));

    // The model statements of the placed IRIs (and of every element of the view: the shows test), without the shapes statements.
    const elementObjects = elements ? [] : [...vq.values()].flatMap(e => (e.props.get(ELEMENT) ?? []).filter(o => o.termType === 'NamedNode').map(o => o.value));
    const wanted = [...new Set([...placed, ...elementObjects])].filter(s => s !== viewIri && !views.has(s) && !marksOf([s]).length && !s.startsWith(BLANK));
    const placedRows = wanted.flatMap(rowsOf);
    const modelRows = placedRows.filter(r => !shapeRow(r)), shapeRows = placedRows.filter(shapeRow);
    const valueSetTypes = new Set(SKOS_TYPES.filter(t => !t.value.endsWith('#Concept')).map(t => t.value));
    const shows = !elements && elementObjects.some(o => shapes.shapeSubjects.has(`<${o}>`)
        || modelRows.some(r => r.s.value === o && r.p.value === TYPE && valueSetTypes.has(r.o.value)));
    // A blank node of the answer is never a placed element: the port names blank nodes per request, a view blank node can have the same name.

    const statements = new Map<string, Statements>();
    const seen = new Set<string>();
    const push = (r: Row) => {
        const k = statementKey(r);
        if (seen.has(k)) return;
        seen.add(k);
        const s = plain(r.s);
        let e = statements.get(key(s));
        if (!e) statements.set(key(s), e = { s, rows: [] });
        e.rows.push({ s, p: plain(r.p), o: plain(r.o) });
    };
    for (const r of modelRows) if (placed.has(r.s.value)) push(r);
    // A view that shows shapes: the SKOS subjects among the placed IRIs and the members of the placed value sets, with their model statements.
    const skosTypes = new Set(SKOS_TYPES.map(t => t.value)), membership = new Set(SKOS_MEMBERSHIP.map(p => p.value));
    if (shows) {
        const setsByIri = new Map(Object.values(model.valueSets).map(v => [v.uri, v]));
        const members = [...placed].flatMap(iri => setsByIri.get(iri)?.members.map(m => m.uri) ?? []).filter(m => !m.startsWith(BLANK));
        const skosRows = [...new Set([...placed, ...members])].filter(s => !s.startsWith(BLANK) && !views.has(s)).flatMap(rowsOf).filter(r => !shapeRow(r));
        const skos = new Set(skosRows.filter(r => r.p.value === TYPE && skosTypes.has(r.o.value)).map(r => r.s.value));
        for (const r of skosRows) if (skos.has(r.s.value)) push(r);
    }
    const subjects = [...statements.values()].filter(e => e.s.termType === 'NamedNode' && e.s.value !== UNION_GRAPH
        && ((placed.has(e.s.value) && !isShape(e.s.term) && !e.s.value.startsWith('urn:trellis:list:') && !viewSubjects.has(e.s.value))
            || e.rows.some(r => r.p.value === TYPE || r.p.value === LABEL)));

    /** The statements of SKOS subjects of the shapes, by document (sorted by file) and subject. */
    const vocabularyHomes = (rows: Row[]) => {
        const byFile = new Map<string, Map<string, Row[]>>();
        for (const r of rows) {
            const file = inShapes.documentOf(r);
            if (file === undefined) continue;
            const bySubject = byFile.get(file) ?? byFile.set(file, new Map()).get(file)!;
            (bySubject.get(r.s.value) ?? bySubject.set(r.s.value, []).get(r.s.value)!).push(r);
        }
        const isVocabulary = (rs: Row[]) => rs.some(r => (r.p.value === TYPE && skosTypes.has(r.o.value)) || membership.has(r.p.value));
        return [...byFile].sort((a, b) => cmp(a[0], b[0]))
            .map(([file, bySubject]) => [file, new Map([...bySubject].filter(([, rs]) => isVocabulary(rs)))] as const);
    };
    const asStatements = (rs: Row[]): Statements => ({ s: plain(rs[0].s), rows: rs.map(r => ({ s: plain(r.s), p: plain(r.p), o: plain(r.o) })) });
    const files = new Map<string, string>();
    if (shows) {
        // A view with shape elements: the SKOS subjects of the shapes (the closure) that are not instances above, with their statements of the first such document.
        const known = new Set(subjects.map(e => e.s.value));
        const closureRows = readLegacy(shapes.closure).quads.filter(q => q.subject.termType === 'NamedNode' && !q.subject.value.startsWith(BLANK)).map(q => ({ s: q.subject, p: q.predicate, o: q.object }));
        for (const [file, bySubject] of vocabularyHomes(closureRows)) for (const [iri, rs] of bySubject) {
            if (known.has(iri)) continue;
            known.add(iri);
            files.set(iri, file);
            subjects.push(asStatements(rs));
        }
    }
    if (elements) {
        // The placed instances that are SKOS subjects of the shapes and not instances of the model: their statements of the first such document.
        const subjectValues = new Set(subjects.map(s => s.s.value));
        const modelInstances = new Set(modelRows.filter(r => r.p.value === TYPE || r.p.value === LABEL).map(r => r.s.value));
        const homes = vocabularyHomes(shapeRows);
        for (const iri of placed) {
            if (iri === UNION_GRAPH || subjectValues.has(iri) || modelInstances.has(iri)) continue;
            const home = homes.find(([, bySubject]) => bySubject.has(iri));
            if (!home) continue;
            subjects.push(asStatements(home[1].get(iri)!));
            files.set(iri, home[0]);
        }
    }
    // Include statement-free endpoints before classifying references as fields or relations.
    const subjectValues = new Set(subjects.map(e => e.s.value));
    const emptySubjects: string[] = [];
    const placedIris = new Set([...vq.values()].flatMap(e => [...e.props.get(ELEMENT) ?? [], ...(groups.includes(e.s.value) ? e.props.get(MEMBER) ?? [] : [])]
        .filter(t => t.termType === 'NamedNode').map(t => t.value)));
    for (const iri of wanted) {
        if (!placedIris.has(iri) || !placed.has(iri) || subjectValues.has(iri) || isShape(rdf.namedNode(iri))
            || iri === UNION_GRAPH || viewSubjects.has(iri) || iri.startsWith('urn:trellis:list:')) continue;
        subjects.push({ s: plain(rdf.namedNode(iri)), rows: [] });
        subjectValues.add(iri);
        emptySubjects.push(iri);
    }
    const { instanceIds, relationIds } = instanceRecords(doc, subjects, files, warnings, language);
    // Only unread placeholders may reuse their instance from the last complete draw.
    for (const iri of emptySubjects) {
        const id = instanceIds.get(iri)!;
        const cached = misses.has(iri) && answer.records?.instances[id];
        if (cached) doc.instances[id] = cached;
    }
    if (misses.size) {
        for (const e of vq.values()) for (const t of e.props.get(REIFIES) ?? []) {
            if (t.termType !== 'Quad' || [t.subject, t.predicate, t.object].some(x => x.termType !== 'NamedNode') || t.predicate.value === ARROW) continue;
            if (!misses.has(t.subject.value) && !misses.has(t.object.value)) continue;
            const k = `${t.subject.value} ${t.predicate.value} ${t.object.value}`;
            if (relationIds.has(k)) continue;
            const id = relationId(t.subject as NamedNode, t.predicate as NamedNode, t.object as NamedNode);
            doc.relations[id] = answer.records?.relations[id] ?? { id, subject: elementId(t.subject as NamedNode), predicate: t.predicate.value, object: elementId(t.object as NamedNode) };
            relationIds.set(k, id);
        }
    }

    if (elements) {
        placementsOf(placed).forEach(pl => placementIds.add(pl));
        // The placements of the relations of the read model.
        const triples = new Set(Object.keys(doc.relations).map(id => { const t = relationTriple(id)!; return `${t.s.value} ${t.p.value} ${t.o.value}`; }));
        for (const [s, e] of vq) for (const o of e.props.get(REIFIES) ?? []) {
            if (o.termType === 'Quad' && triples.has(`${o.subject.value} ${o.predicate.value} ${o.object.value}`)) placementIds.add(s);
        }
    }
    const scoped = placementsIn(scope);

    // Views that the part names: this view and the targets of its view references.
    const scopedElements = [...new Set(scoped.flatMap(pl => objects(pl, ELEMENT).map(o => o.value)))];
    const scopedMarks = elements ? marksOf(scopedElements) : marksOf(placementElements);
    const arrowPairs = new Set(scoped.flatMap(pl => objects(pl, REIFIES).flatMap(o => o.termType === 'Quad' && o.predicate.value === ARROW
        ? [`${termKey(o.subject)} ${termKey(o.object)}`] : [])));
    const arrowStatements = new Set<string>();
    for (const e of vq.values()) for (const o of e.props.get(ARROW) ?? []) if (arrowPairs.has(`${termKey(e.s)} ${termKey(o)}`)) arrowStatements.add(`${key(plain(e.s))} ${key(plain(o))}`);
    const named = new Set([viewIri, ...scopedElements].filter(g => viewGraphs.has(g)));
    const viewIds = new Map([...named].map(graph => [graph, elementId(rdf.namedNode(graph))]));

    // Placements of the view graph. A placement of a relation or an arrow reifies its triple.
    const placementResources: Resource[] = scoped.map(pl => {
        const values = new Map<string, Plain[]>();
        for (const p of PLACEMENT_PROPS) { const os = objects(pl, NS.view + p); if (os.length) values.set(p, os.map(plain)); }
        const triples = objects(pl, REIFIES).filter((o): o is Quad => o.termType === 'Quad');
        for (const [v, part] of [['subject', 'subject'], ['predicate', 'predicate'], ['object', 'object']] as const) {
            const ts = triples.map(t => plain(t[part])).filter((t, i, all) => all.findIndex(x => key(x) === key(t)) === i);
            if (ts.length) values.set(v, ts);
        }
        return { s: plain(vq.get(pl)!.s), values };
    });
    // The marks that the placements place, with their content. A subject with two mark types: the last of MARKS.
    const marks = new Map<string, { kind: typeof MARKS[number][1]; r: Resource }>();
    for (const [type, kind, prop] of MARKS) for (const m of scopedMarks) {
        if (!objects(m, TYPE).some(t => t.value === NS.view + type)) continue;
        const s = plain(vq.get(m)!.s), values = new Map<string, Plain[]>();
        const os = objects(m, prop);
        if (os.length) values.set(MARK_VALUE[prop], os.map(plain));
        marks.set(key(s), { kind, r: { s, values } });
    }
    const parts: Parameters<typeof projectView>[2] & { fileReferences: Resource[] } = {
        cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: []
    };
    for (const r of placementResources) {
        const e = first(r.values.get('element'));
        const mark = e && marks.get(key(e));
        if (!e && r.values.has('subject')) (first(r.values.get('predicate'))?.value === ARROW ? parts.arrows : parts.edges).push(r);
        else if (mark) parts[mark.kind].push({ s: r.s, values: new Map([...mark.r.values, ...r.values]) });
        else if (e && (e.termType === 'BlankNode' || e.value.startsWith(BLANK))) warnings.push(`placement ${r.s.value}: a blank node cannot be placed`);
        else if (e && e.termType === 'NamedNode' && named.has(e.value)) parts.references.push({ s: r.s, values: new Map([...r.values, ['references', [e]]]) });
        else parts.cards.push(r);
    }

    // Cards: instances, node shapes, value sets, and properties drawn out of their cards (by IRI). A shape wins over an instance.
    const cardIds = cardIdsOf(instanceIds, model);
    const properties = new Set(Object.keys(model.properties));
    for (const graph of [...named].sort(cmp)) {
        const empty = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: [] };
        const e = viewGraphs.get(graph)!;
        const v = projectView(graph, viewLabel(e, language), graph === viewIri ? parts : empty, cardIds, relationIds, viewIds, warnings, arrowStatements, properties);
        if (e.description?.termType === 'Literal') v.description = e.description.value;
        doc.views[v.id] = v;
    }
    return doc;
}
