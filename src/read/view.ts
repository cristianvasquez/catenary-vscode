// The Doc of one view from turtle/query answers (readView of view-read.ts over the ModelPort). Nothing is kept between calls.
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { type Doc, emptyDoc } from '../catenary/model/doc';
import { pickLabel } from '../catenary/model/labels';
import { NS, publishedIri } from '../catenary/model/terms';
import { UNION_GRAPH } from '../catenary/rdf/files';
import { elementId, elementTerm, relationTriple } from '../catenary/rdf/ids';
import { readLegacy } from '../catenary/rdf/loader';
import { type Plain, type Resource, type Statements, cardIdsOf, first, instanceRecords, key, projectView } from '../catenary/rdf/records';
import { rdf, termKey } from '../catenary/rdf/terms';
import { P, SKOS_MEMBERSHIP, SKOS_TYPES, labelFromIri, labelLiterals } from '../catenary/rdf/vocabulary';
import { byFile, type ModelPort, type Row } from '../model/port';
import type { ManifestRecords } from './manifest';
import type { ShapesModelRecords } from './shapes';

/** `oview:`: the legacy namespace of view: (LEGACY_NAMESPACES of model/terms.ts). The view queries match both; readLegacy maps the answers. */
const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX oview: <osg://vocab/view#> PREFIX skos: <${NS.skos}>`;

const MARKS = [['Frame', 'groups', 'label'], ['Note', 'notes', 'text'], ['FileRef', 'fileReferences', 'file'], ['EntityGroup', 'collections', 'member']] as const;

const MARK_TYPES = MARKS.flatMap(([t]) => [`view:${t}`, `oview:${t}`]).join(', ');

const PLACEMENT_PROPS = ['element', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide', 'vertices'];

/** The prefix of the IRI that the port gives for a blank node (port.ts, toEngine of model/nquads.ts). */
const BLANK = 'urn:skolem:blank:';

/** The IRIs of a VALUES block, at most this many per query. */
const CHUNK = 500;

const TYPE = P.type.value, LABEL = P.label.value, ELEMENT = NS.view + 'element', REIFIES = NS.rdf + 'reifies', ARROW = NS.view + 'arrow';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });

/** The view:View subjects of a view file, their labels and their view:description. */
const VIEW_SUBJECTS = `${PREFIXES} SELECT ?v ?l ?d WHERE { ?v a ?vt FILTER (?vt IN (view:View, oview:View))
    OPTIONAL { ?v rdfs:label ?l } OPTIONAL { ?v view:description|oview:description ?d } }`;

/**
 * The marks of a view file, with their content (run per view file, byFile). No VALUES: a blank-node mark comes back as a skolem IRI
 * (answerPort) that a VALUES IRI does not match on the server; the rows are matched in code. `?ref`: the view:file of a file reference
 * (`?file` is the file of the row, byFile).
 */
const MARKS_ALL = `${PREFIXES} SELECT ?s ?mt ?label ?text ?ref ?member WHERE { ?s a ?mt FILTER (?mt IN (${MARK_TYPES}))
    OPTIONAL { ?s rdfs:label ?label } OPTIONAL { ?s view:text|oview:text ?text } OPTIONAL { ?s view:file|oview:file ?ref }
    OPTIONAL { ?s view:member|oview:member ?member } }`;

/** The variable of MARKS_ALL for the content property of a mark. */
const MARK_VAR: Record<string, string> = { file: 'ref' };

/** The statements of `?s` in a model document (byFile); `?known`: the object has an rdf:type or an rdfs:label in that document. */
const statementsQuery = (values: string) => `${PREFIXES} SELECT ?s ?p ?o ?known WHERE { VALUES ?s { ${values} } ?s ?p ?o FILTER (isIRI(?s))
    BIND (EXISTS { ?o rdf:type|rdfs:label ?any } AS ?known) }`;

/** As statementsQuery for the blank-node subjects, once over the whole folder: a query cannot name a blank node; the rows are matched in code. */
const BLANK_STATEMENTS = `${PREFIXES} SELECT ?s ?p ?o ?known WHERE { ?s ?p ?o FILTER (isBlank(?s))
    BIND (EXISTS { ?o rdf:type|rdfs:label ?any } AS ?known) }`;

/** The statements of each IRI subject with a SKOS type, skos:inScheme or skos:topConceptOf in a model document (byFile). */
const SKOS = `${PREFIXES} SELECT DISTINCT ?s ?p ?o WHERE {
    { ?s a ?t VALUES ?t { skos:ConceptScheme skos:Concept skos:Collection } } UNION { ?s skos:inScheme|skos:topConceptOf ?x }
    ?s ?p ?o FILTER (isIRI(?s)) }`;

/** The view:member statements of a view file (byFile, matched in code, as MARKS_ALL). */
const MEMBERS_ALL = `${PREFIXES} SELECT ?c ?m WHERE { ?c view:member|oview:member ?m }`;

/** The arrow statements `?s view:arrow ?o` of a view file (byFile, matched in code, as MARKS_ALL). */
const ARROWS_ALL = `${PREFIXES} SELECT DISTINCT ?s ?o WHERE { ?s view:arrow|oview:arrow ?o }`;

type FileRow = Row & { file: string };

/** One byFile query over `files` per CHUNK IRIs (named nodes only: VALUES of `<iri>`), the rows concatenated. */
async function chunked(port: ModelPort, iris: Iterable<string>, query: (values: string) => string, files: string[]): Promise<FileRow[]> {
    const all = [...new Set(iris)];
    const parts: string[][] = [];
    for (let i = 0; i < all.length; i += CHUNK) parts.push(all.slice(i, i + CHUNK));
    return (await Promise.all(parts.map(p => byFile(port, files, query(p.map(s => `<${s}>`).join(' ')))))).flat();
}

/** The rows with their terms in the published namespaces (readLegacy over the quads of `?s ?p ?o`); the other variables unchanged. */
export function legacyRows<R extends Row>(rows: R[]): R[] {
    const { quads, changed } = readLegacy(rows.map(r => rdf.quad(r.s as Quad['subject'], r.p as Quad['predicate'], r.o as Quad['object'])));
    return changed ? rows.map((r, i) => ({ ...r, s: quads[i].subject, p: quads[i].predicate, o: quads[i].object })) : rows;
}

/** A row with each IRI in a legacy namespace replaced by its published IRI (as readLegacy); the file of the row stays. */
const published = <R extends Row>(r: R): R => Object.fromEntries(Object.entries(r).map(([k, t]) => [k, typeof t !== 'string' && t.termType === 'NamedNode' ? rdf.namedNode(publishedIri(t.value)) : t])) as R;

type ViewGraph = { subjects: Map<string, { v: Term; labels: Term[] }>; description?: Term };

/** The views by IRI: for each view file of `views` (view IRI → file path), its view:View subject that is the view IRI, read with `files: [file]`. */
async function viewGraphsOf(port: ModelPort, views: Map<string, string>): Promise<Map<string, ViewGraph>> {
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
export async function viewLabelsOf(port: ModelPort, views: Map<string, string>, language?: string): Promise<Record<string, string>> {
    const graphs = await viewGraphsOf(port, views);
    return Object.fromEntries([...graphs].sort((a, b) => cmp(a[0], b[0])).map(([graph, e]) => [elementId(rdf.namedNode(graph)), viewLabel(e, language)]));
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

/**
 * The Doc of the view `viewIri` (readView of view-read.ts): the view, the instances it places (and the SKOS vocabulary when it shows shapes),
 * their relations, and the views it names. An empty Doc when `viewIri` is not a view of `views` (view IRI → file path, ModelContext.views).
 * `elements`: only these placements and what they need (scopedDoc). `warnings`: receives what the view cannot show.
 */
export async function viewDocOf(port: ModelPort, views: Map<string, string>, viewIri: string, shapes: ShapesModelRecords, manifest: ManifestRecords,
    options: { elements?: string[]; warnings?: string[] } = {}): Promise<Doc> {
    const { elements, warnings = [] } = options;
    const language = manifest.language, modelFiles = shapes.files, model = shapes.index.model;
    const viewFile = views.get(viewIri);
    if (!viewFile) return emptyDoc();
    /** A shape subject of any document (the shows test, the object test of the statements filter). */
    const isShape = (t: Term) => shapes.shapeSubjects.has(termKey(t));
    /**
     * The subject of the row is a shape in the row's document (shapePart classifies per file). A row without a file (a blank-node subject,
     * read over the whole folder): a shape in any document.
     */
    const shapeRow = (r: Row & { file?: string }) => r.file === undefined ? isShape(r.s) : shapes.shapeSubjectsByFile.get(r.file)?.has(termKey(r.s)) ?? false;
    /** The view IRI of a view file. */
    const viewOf = new Map([...views].map(([iri, file]) => [file, iri]));
    const viewFiles = [...views.values()];
    const [viewGraphs, viewRows] = await Promise.all([viewGraphsOf(port, views),
        port.select('SELECT ?s ?p ?o WHERE { ?s ?p ?o }', [viewFile]).then(legacyRows)]);
    if (!viewGraphs.has(viewIri)) return emptyDoc();
    const vq = viewQuadsOf(viewRows);
    const objects = (s: string, p: string): Term[] => vq.get(s)?.props.get(p) ?? [];
    const isPlacement = (s: string) => objects(s, TYPE).some(t => t.value === NS.view + 'Placement');
    /** The placements of the view graph, or the placements among `scope`. */
    const placementsIn = (scope?: Set<string>) => [...vq.keys()].filter(s => isPlacement(s) && (!scope || scope.has(s))).sort(cmp);
    let allMarks: Promise<FileRow[]> | undefined;
    const marksOf = async (subjects: Iterable<string>) => {
        const wanted = new Set(subjects);
        return (await (allMarks ??= byFile(port, viewFiles, MARKS_ALL).then(rows => rows.map(published)))).filter(r => wanted.has(r.s.value));
    };

    const doc = emptyDoc();
    doc.shapes = model;
    const requested = new Set<string>();
    const placementIds = new Set<string>();
    const setsOfMember = new Map<string, string[]>();
    for (const set of Object.values(model.valueSets)) for (const m of set.members) setsOfMember.set(m.uri, [...setsOfMember.get(m.uri) ?? [], set.uri]);
    const memberOf = new Map<string, string[]>();
    const readMembers = async (terms: Iterable<string>) => {
        const missing = new Set([...terms].filter(t => !memberOf.has(t)));
        for (const t of missing) memberOf.set(t, []);
        if (!missing.size) return;
        for (const r of (await byFile(port, viewFiles, MEMBERS_ALL)).map(published)) if (missing.has(r.m.value)) memberOf.get(r.m.value)!.push(r.c.value);
    };
    const add = (id: string) => {
        const part = model.properties[id] ?? model.constraints[id];
        const owner = part && model.nodeShapes[part.owner];
        const term = elementTerm(id);
        if (term) {
            requested.add(term.value);
            for (const set of setsOfMember.get(term.value) ?? []) requested.add(set);
            for (const c of memberOf.get(term.value) ?? []) requested.add(c);
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
        const targets = subjects.flatMap(s => objects(s, ELEMENT).filter(o => o.termType === 'NamedNode').map(o => o.value));
        // The frames among the elements of these subjects (a frame mark in a view graph), with the geometry of the subject.
        const frameTerms = new Set((await marksOf(subjects.flatMap(s => objects(s, ELEMENT).map(o => o.value)))).filter(r => r.mt.value === NS.view + 'Frame').map(r => r.s.value));
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
        await readMembers([...terms.values(), ...targets, ...inFrames.flatMap(id => elementTerm(id)?.value ?? [])]);
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
    const markRows = await marksOf(placementElements);
    const placed = new Set(placementElements);
    for (const r of markRows) if (r.mt.value === NS.view + 'EntityGroup' && r.member) placed.add(r.member.value);
    if (elements) requested.forEach(e => placed.add(e));

    // The model statements of the placed IRIs (and of every element of the view: the shows test), without the shapes subjects.
    const elementObjects = elements ? [] : [...vq.values()].flatMap(e => (e.props.get(ELEMENT) ?? []).filter(o => o.termType === 'NamedNode').map(o => o.value));
    // Blank nodes of a model document: one isBlank query, matched in code by the skolem IRI of the port.
    const wanted = new Set([...placed, ...elementObjects]);
    const blanks = new Set([...wanted].filter(s => s.startsWith(BLANK)));
    const [namedRows, blankRows] = await Promise.all([chunked(port, [...wanted].filter(s => !blanks.has(s)), statementsQuery, modelFiles),
        blanks.size ? port.select(BLANK_STATEMENTS).then(rows => rows.filter(r => blanks.has(r.s.value))) : []]);
    const placedRows = legacyRows<Row & { file?: string }>([...namedRows, ...blankRows]);
    const modelRows = placedRows.filter(r => !shapeRow(r)), shapeRows = placedRows.filter(shapeRow);
    const valueSetTypes = new Set(SKOS_TYPES.filter(t => !t.value.endsWith('#Concept')).map(t => t.value));
    const shows = !elements && elementObjects.some(o => shapes.shapeSubjects.has(`<${o}>`)
        || modelRows.some(r => r.s.value === o && r.p.value === TYPE && valueSetTypes.has(r.o.value)));
        const keep = (r: Row) => !!elements || r.p.value === TYPE || r.o.termType !== 'NamedNode' || placed.has(r.o.value) || !(r.known?.value === 'true' && !isShape(r.o));

    const statements = new Map<string, Statements>();
    const seen = new Set<string>();
    const push = (r: Row) => {
        const k = `${termKey(r.s)} ${termKey(r.p)} ${termKey(r.o)}`;
        if (seen.has(k)) return;
        seen.add(k);
        const s = plain(r.s);
        let e = statements.get(key(s));
        if (!e) statements.set(key(s), e = { s, rows: [] });
        e.rows.push({ s, p: plain(r.p), o: plain(r.o) });
    };
    for (const r of modelRows) if (placed.has(r.s.value) && keep(r)) push(r);
    const skosRows = shows ? legacyRows(await byFile(port, modelFiles, SKOS)) : [];
    const skosTypes = new Set(SKOS_TYPES.map(t => t.value)), membership = new Set(SKOS_MEMBERSHIP.map(p => p.value));
    const skosUnion = new Set(skosRows.filter(r => !shapeRow(r) && r.p.value === TYPE && skosTypes.has(r.o.value)).map(r => r.s.value));
    for (const r of skosRows) if (skosUnion.has(r.s.value) && !shapeRow(r)) push(r);
    const subjects = [...statements.values()].filter(e => e.s.termType === 'NamedNode' && e.s.value !== UNION_GRAPH && e.rows.some(r => r.p.value === TYPE || r.p.value === LABEL));

    /** The statements of SKOS subjects of the shapes, by document (sorted by file) and subject. */
    const vocabularyHomes = (rows: (Row & { file?: string })[]) => {
        const byFile = new Map<string, Map<string, Row[]>>();
        for (const r of rows) {
            if (r.file === undefined) continue;
            const bySubject = byFile.get(r.file) ?? byFile.set(r.file, new Map()).get(r.file)!;
            (bySubject.get(r.s.value) ?? bySubject.set(r.s.value, []).get(r.s.value)!).push(r);
        }
        const isVocabulary = (rs: Row[]) => rs.some(r => (r.p.value === TYPE && skosTypes.has(r.o.value)) || membership.has(r.p.value));
        return [...byFile].sort((a, b) => cmp(a[0], b[0]))
            .map(([file, bySubject]) => [file, new Map([...bySubject].filter(([, rs]) => isVocabulary(rs)))] as const);
    };
    const asStatements = (rs: Row[]): Statements => ({ s: plain(rs[0].s), rows: rs.map(r => ({ s: plain(r.s), p: plain(r.p), o: plain(r.o) })) });
    const files = new Map<string, string>();
    if (shows) {
        // A view with shape elements: the SKOS subjects of the shapes that are not instances above, with their statements of the first such document.
        const known = new Set(subjects.map(e => e.s.value));
        for (const [file, bySubject] of vocabularyHomes(skosRows.filter(shapeRow))) for (const [iri, rs] of bySubject) {
            if (rs[0].s.termType !== 'NamedNode' || known.has(iri)) continue;
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
    const { instanceIds, relationIds } = instanceRecords(doc, subjects, files, warnings, language);

    if (elements) {
        placementsOf(placed).forEach(pl => placementIds.add(pl));
        // The placements of the relations of the read model.
        const triples = new Set(Object.keys(doc.relations).map(id => { const t = relationTriple(id)!; return `${t.s.value} ${t.p.value} ${t.o.value}`; }));
        for (const [s, e] of vq) for (const o of e.props.get(REIFIES) ?? []) {
            if (o.termType === 'Quad' && triples.has(`${o.subject.value} ${o.predicate.value} ${o.object.value}`)) placementIds.add(s);
        }
    }
    const scoped = placementsIn(scope);

    // Views that the part names: this view, the targets of its view references, the graphs of the marks and arrows it places.
    const scopedElements = [...new Set(scoped.flatMap(pl => objects(pl, ELEMENT).map(o => o.value)))];
    const scopedMarks = elements ? await marksOf(scopedElements) : markRows;
    const arrowPairs = new Set(scoped.flatMap(pl => objects(pl, REIFIES).flatMap(o => o.termType === 'Quad' && o.predicate.value === ARROW
        ? [`${termKey(o.subject)} ${termKey(o.object)}`] : [])));
    const arrowRows = arrowPairs.size ? (await byFile(port, viewFiles, ARROWS_ALL)).map(published).filter(r => arrowPairs.has(`${termKey(r.s)} ${termKey(r.o)}`)) : [];
    const named = new Set([viewIri, ...scopedElements, ...[...scopedMarks, ...arrowRows].flatMap(r => viewOf.get(r.file) ?? [])].filter(g => viewGraphs.has(g)));
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
    for (const [type, kind, prop] of MARKS) {
        const bySubject = new Map<string, Resource>();
        for (const r of scopedMarks.filter(x => x.mt.value === NS.view + type)) {
            const s = plain(r.s);
            let e = bySubject.get(key(s));
            if (!e) bySubject.set(key(s), e = { s, values: new Map() });
            const o = r[MARK_VAR[prop] ?? prop];
            if (!o) continue;
            const os = e.values.get(prop);
            if (!os) e.values.set(prop, [plain(o)]);
            else if (!os.some(x => key(x) === key(plain(o)))) os.push(plain(o));
        }
        for (const [k, r] of bySubject) marks.set(k, { kind, r });
    }
    const parts: Parameters<typeof projectView>[2] & { fileReferences: Resource[] } = {
        cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: []
    };
    for (const r of placementResources) {
        const e = first(r.values.get('element'));
        const mark = e && marks.get(key(e));
        if (!e && r.values.has('subject')) (first(r.values.get('predicate'))?.value === ARROW ? parts.arrows : parts.edges).push(r);
        else if (mark) parts[mark.kind].push({ s: r.s, values: new Map([...mark.r.values, ...r.values]) });
        else if (e && e.termType === 'NamedNode' && named.has(e.value)) parts.references.push({ s: r.s, values: new Map([...r.values, ['references', [e]]]) });
        else parts.cards.push(r);
    }
    const arrowStatements = new Set(arrowRows.map(r => `${key(plain(r.s))} ${key(plain(r.o))}`));

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
