// Read view-scoped instances, relations and hidden-neighbour counts; adapted from Catenary packages/rdf/src/scoped-doc.ts.
import { shapeTargetMatches } from './shacl-targets';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { Doc, View, boxes, emptyDoc } from '../model/doc';
import { NS } from '../model/terms';
import { ShapesModel } from '../model/shapes-doc';
import { ModelGraph } from './graph';
import { fileOfGraph } from './graph-names';
import { cmp } from '../rdf-core/graph';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import { Plain, Statements, instanceRecords, key, select } from './records';
import { homesAmong, inModelAmong, instancesAmong } from './quad-read';
import { rdf } from './terms';
import { ViewReadContext, readView, viewLabels } from './view-read';
import { homeOf } from './vocabulary';
import { isView } from './views';


export interface DocScope {
    /** Element ids: instances, relations, views and shape elements. A placement id of one of `views` stands for its element. */
    elements?: string[];
    /** Also the instances related to the instances of `elements`, with the relations to them. */
    neighbors?: boolean;
    /** Views whose selected placements and dependencies are read. */
    selectionViews?: (string | undefined)[];
    /** Views to read in full. */
    views?: (string | undefined)[];
    /**
     * Also read every view that can show an element of `elements`: a view that places it, the ends of a relation, the value set of a
     * concept or the node shape of a shape element, or a view that refers to a view of `elements`.
     */
    showing?: boolean;
}


const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}>`;

const iri = (s: string) => `<${s}>`;

const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });


/** A view entry with its label only. */
const labelOnly = (id: string, label: string): View => ({ id, label, uri: elementTerm(id)?.value ?? '', boxes: [], edges: [], arrows: [] });


export function scopedDoc(ctx: ViewReadContext, scope: DocScope): Doc {
    const { g, shapes } = ctx;
    const doc = emptyDoc();
    doc.shapes = shapes;
    for (const [id, label] of Object.entries(viewLabels(g))) doc.views[id] = labelOnly(id, label);
    const read = new Set<string>();
    const readPart = (viewId: string, elements?: string[]) => {
        if (read.has(viewId) || !doc.views[viewId]) return;
        read.add(viewId);
        const part = readView(g, viewId, shapes, [], elements);
        if (part.views[viewId]) doc.views[viewId] = part.views[viewId];
        for (const [id, i] of Object.entries(part.instances)) doc.instances[id] ??= i;
        for (const [id, r] of Object.entries(part.relations)) doc.relations[id] ??= r;
    };
    const views = (scope.views ?? []).filter((v): v is string => !!v);
    views.forEach(v => readPart(v));
    const selectedViews = (scope.selectionViews ?? []).filter((v): v is string => !!v);
    selectedViews.forEach(v => readPart(v, scope.elements ?? []));

    // Elements: a placement id of a read view stands for its element. The placements of the read views by id once (elementOfId
    // scans the boxes of a view for each id).
    const elementOf = new Map<string, string>();
    for (const v of [...views, ...selectedViews].reverse()) {
        const view = doc.views[v];
        if (!view) continue;
        for (const e of view.edges) if (e.id) elementOf.set(e.id, e.relation);
        for (const b of view.boxes) if (b.kind === 'card') elementOf.set(b.id, b.element);
    }
    const elements = [...new Set((scope.elements ?? []).map(id => elementOf.get(id) ?? id))];
    // The instance check of all element terms in one query, not one read per data graph and term.
    const terms = elements.flatMap(id => { const t = relationTriple(id); return (t ? [t.s, t.o] : [elementTerm(id)]).flatMap(x => x?.termType === 'NamedNode' ? [x.value] : []); });
    const instances = new Set<string>(instancesAmong(g, terms));
    const own = [...instances];
    if (scope.neighbors && own.length) for (const x of neighbors(g, own)) instances.add(x);
    if (instances.size && (scope.neighbors || [...instances].some(s => !doc.instances[elementId(rdf.namedNode(s))]))) records(g, doc, [...instances]);

    if (scope.showing) for (const v of viewsPlacing(g, showingTerms(doc, elements, own))) readPart(v, elements);
    return doc;
}


/** The instances with a statement to or from one of `subjects` (model graph and shapes graphs). */
function neighbors(g: ModelGraph, subjects: string[]): string[] {
    const graphs = [...new Set([...g.dataGraphs(), ...g.shapesGraphs()].map(t => iri(t.value)))].join(', ');
    const found = select(g, `${PREFIXES} SELECT DISTINCT ?x WHERE {
        VALUES ?s { ${subjects.map(iri).join(' ')} }
        { GRAPH ?g { ?s ?p ?x } } UNION { GRAPH ?g { ?x ?p ?s } }
        FILTER (isIRI(?x) && ?g IN (${graphs}) && ?p NOT IN (rdf:type, rdfs:label)) }`);
    const instances = instancesAmong(g, found.map(r => r.x.value));
    return found.map(r => r.x.value).filter(x => instances.has(x));
}


/**
 * Instance records of `iris` (each an instance of the store) and the relations between them, into `doc`. The statements of an
 * instance of the model graph are its model graph statements; of a SKOS subject of a shapes file, its statements of that graph.
 */
function records(g: ModelGraph, doc: Doc, iris: string[]): void {
    const statements = new Map<string, Statements>();
    for (const r of select(g, `SELECT ?s ?p ?o WHERE { VALUES ?s { ${iris.map(iri).join(' ')} } GRAPH ${iri(g.union.value)} { ?s ?p ?o } }`)) {
        if (!g.isDataTriple(r.s.term, r.p.term, r.o.term)) continue;
        let e = statements.get(key(r.s));
        if (!e) statements.set(key(r.s), e = { s: r.s, rows: [] });
        e.rows.push(r);
    }
    const files = new Map<string, string>();
    const subjects: Statements[] = [];
    const inModel = inModelAmong(g, iris);
    for (const s of iris) {
        const t = rdf.namedNode(s);
        const home = inModel.has(s) ? g.union : homeOf(g, t);
        if (home.equals(g.union)) {
            const e = statements.get('NamedNode ' + s);
            if (e) subjects.push(e);
            continue;
        }
        files.set(s, fileOfGraph(home.value));
        const rows = g.match(t, null, null, home).map(q => ({ s: plain(q.subject), p: plain(q.predicate), o: plain(q.object) }));
        if (rows.length) subjects.push({ s: rows[0].s, rows });
    }
    const part = emptyDoc();
    instanceRecords(part, subjects, files, [], g.language);
    Object.assign(doc.instances, part.instances);
    Object.assign(doc.relations, part.relations);
}


/** The terms whose placement makes a view show one of `elements` (see DocScope.showing). `instances`: the instances among them. */
function showingTerms(doc: Doc, elements: string[], instances: string[]): string[] {
    const { nodeShapes, properties, constraints, valueSets } = doc.shapes;
    const terms = new Set<string>(instances);
    for (const id of elements) {
        const owner = properties[id]?.owner ?? constraints[id]?.owner ?? id;
        const shape = nodeShapes[owner]?.uri ?? valueSets[id]?.uri;
        if (shape) terms.add(shape);
        if (doc.views[id]) terms.add(doc.views[id].uri);
    }
    for (const s of Object.values(valueSets)) if (s.members.some(m => instances.includes(m.uri))) terms.add(s.uri);
    return [...terms];
}


/** The views (ids) with a placement of one of `terms`. */
function viewsPlacing(g: ModelGraph, terms: string[]): string[] {
    if (!terms.length) return [];
    return select(g, `${PREFIXES} SELECT DISTINCT ?g WHERE { VALUES ?e { ${terms.map(iri).join(' ')} } GRAPH ?g { ?n a view:Placement ; view:element ?e } }`)
        .filter(r => r.g.termType === 'NamedNode' && isView(g, r.g.term)).map(r => elementId(r.g.term as NamedNode)).sort(cmp);
}


/** A row of the card halo: related instances in and out that the view does not show, and shapes or targets that it does not show. */
export type NeighborCount = { in: number; out: number; targets?: number };


/**
 * For each instance card of `view`: the number of instances related to it ('in': subjects of its relations, 'out': objects) that the
 * view does not show, or whose relation is hidden. Matches `hiddenNeighbors` on rows of the cards, without the records of all instances.
 */
export function hiddenNeighborCounts(g: ModelGraph, shapes: ShapesModel, view: View): Map<string, NeighborCount> {
    // The instance test of all cards in one request, not one store read per card.
    const cardTerms = boxes(view, 'card').flatMap(b => { const t = elementTerm(b.element); return t?.termType === 'NamedNode' ? [{ b, t }] : []; });
    const cardInstances = instancesAmong(g, cardTerms.map(c => c.t.value));
    const cards = new Map<string, string>();
    for (const { b, t } of cardTerms) if (cardInstances.has(t.value)) cards.set(t.value, b.element);
    const out = new Map<string, NeighborCount>();
    const placed = new Set(boxes(view, 'card').map(b => b.element));
    // The IRIs of the cards once: a test by IRI, not an id built for each target.
    const placedIris = new Set(cardTerms.map(c => c.t.value));
    // One request for all shape cards, not one per card.
    const placedShapes = Object.values(shapes.nodeShapes).filter(s => placed.has(s.id));
    const targets = placedShapes.length ? shapeTargetMatches(g, { shapes: placedShapes.map(s => s.uri) }).filter(m => m.node.termType === 'NamedNode' && !placedIris.has(m.node.value)) : [];
    const targetInstances = instancesAmong(g, targets.map(m => m.node.value));
    const hidden = targets.filter(m => targetInstances.has(m.node.value));
    const hiddenOf = new Map<string, number>();
    for (const m of hidden) hiddenOf.set(m.shape, (hiddenOf.get(m.shape) ?? 0) + 1);
    for (const shape of placedShapes) {
        const targets = hiddenOf.get(shape.uri) ?? 0;
        if (targets) out.set(shape.id, { in: 0, out: 0, targets });
    }
    if (!cards.size) return out;
    // The IRIs that the view shows, once: a card, or a member of a shown value set (not a test per neighbor over all boxes).
    const shownIris = new Set<string>(placedIris);
    for (const b of boxes(view, 'card')) for (const m of shapes.valueSets[b.element]?.members ?? []) shownIris.add(m.uri);
    const shown = (iri: string) => cards.has(iri) || shownIris.has(iri);
    const read = [...cards.keys()];
    const counts = new Map<string, { in: number; out: number }>();
    const others = new Map<string, { in: Set<string>; out: Set<string> }>();
    const placedEdges = new Set(view.edges.filter(e => !e.hidden).map(e => e.relation));
    const found: { s: Term; x: Term; p: Term; g: Term; q: Quad; dir: { value: 'in' | 'out' } }[] = [];
    const reading = new Set(read);
    for (const graph of new Map([...g.dataGraphs(), ...g.shapesGraphs()].map(t => [t.value, t])).values()) for (const q of g.match(null, null, null, graph)) {
        if (q.predicate.value === NS.rdf + 'type' || q.predicate.value === NS.rdfs + 'label') continue;
        if (reading.has(q.subject.value) && q.object.termType === 'NamedNode') found.push({ s: q.subject, x: q.object, p: q.predicate, g: graph, q, dir: { value: 'out' } });
        if (reading.has(q.object.value) && q.subject.termType === 'NamedNode') found.push({ s: q.object, x: q.subject, p: q.predicate, g: graph, q, dir: { value: 'in' } });
    }
    // The homes and the instance test of all neighbors in one request each, not one store read per row.
    const homes = homesAmong(g, found.flatMap(r => [r.s.value, r.x.value]));
    const neighborInstances = instancesAmong(g, found.map(r => r.x.value));
    const add = (self: string, dir: 'in' | 'out', other: string) => {
        if (other === self || !neighborInstances.has(other)) return;
        const o = others.get(self) ?? others.set(self, { in: new Set(), out: new Set() }).get(self)!;
        o[dir].add(other);
    };
    for (const r of found) {
        const dir = r.dir.value as 'in' | 'out';
        // A relation is a statement of the graph of its subject (the model graph, or the shapes graph of a SKOS subject).
        const owner = homes.get(dir === 'out' ? r.s.value : r.x.value);
        if (owner === g.union.value ? !g.isDataQuad(r.q) : r.g.value !== owner) continue;
        const [subject, object] = dir === 'out' ? [r.s, r.x] : [r.x, r.s];
        if (shown(r.x.value) && placedEdges.has(relationId(subject as NamedNode, r.p as NamedNode, object as NamedNode))) continue;
        add(r.s.value, dir, r.x.value);
    }
    for (const [self, o] of others) counts.set(self, { in: o.in.size, out: o.out.size });
    // In the order of the cards, as a read of all cards gives them.
    for (const [self, id] of cards) { const c = counts.get(self); if (c) out.set(id, { in: c.in, out: c.out }); }
    const shownShapes = new Set(boxes(view, 'card').map(c => c.element));
    const shapeIds = new Map(Object.values(shapes.nodeShapes).map(s => [s.uri, s.id]));
    // The shapes of each card that the view does not show, from the kept matches of each node (shacl-targets.ts).
    const unshown = new Map<string, number>();
    for (const m of shapeTargetMatches(g, { nodes: [...cards.keys()].map(value => ({ termType: 'NamedNode', value })) })) {
        if (shapeIds.has(m.shape) && !shownShapes.has(shapeIds.get(m.shape)!)) unshown.set(m.node.value, (unshown.get(m.node.value) ?? 0) + 1);
    }
    for (const [uri, id] of cards) {
        const targets = unshown.get(uri) ?? 0;
        const row = out.get(id);
        if (targets && row) row.targets = targets;
        else if (targets) out.set(id, { in: 0, out: 0, targets });
    }
    return out;
}

