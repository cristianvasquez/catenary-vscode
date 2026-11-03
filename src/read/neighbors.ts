// Hidden-neighbour counts of the cards of a view from turtle/query answers, with no kept state.
import type { NamedNode, Term } from '@rdfjs/types';
import { type View, boxes } from '../catenary/model/doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH } from '../catenary/rdf/graph-names';
import { elementTerm, relationId } from '../catenary/rdf/ids';
import type { NeighborCount } from '../catenary/rdf/scoped-doc';
import { termKey } from '../catenary/rdf/terms';
import type { FocusNode } from '../catenary/shacl/common/index';
import type { ModelPort, Row } from '../model/port';
import type { ShapesModelRecords } from './shapes';
import { bindings, shapeTargetMatches } from './targets';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${NS.skos}>`;
const TYPE = NS.rdf + 'type', LABEL = NS.rdfs + 'label';
const SKOS_TYPES = new Set(['ConceptScheme', 'Concept', 'Collection'].map(t => NS.skos + t));
const SKOS_MEMBERSHIP = new Set(['inScheme', 'topConceptOf'].map(p => NS.skos + p));
/** The home of a subject in the model graph (homeOf of rdf/vocabulary.ts). */
const MODEL = '';

const named = (value: string): FocusNode => ({ termType: 'NamedNode', value });

/**
 * The instance test and the home of each IRI (instancesAmong, homesAmong of rdf/quad-read.ts) from one query: rdf:type, rdfs:label and the
 * SKOS membership statements with their document. A statement of a shape subject of its document (the closure) is in the old shapes graph.
 * `types`: the rdf:type objects of each IRI, in every document.
 */
export async function factsOf(port: ModelPort, files: string[], inShapes: (doc: string, s: Term) => boolean, iris: Iterable<string>): Promise<{ instance: Set<string>; home: Map<string, string>; types: Map<string, string[]> }> {
    const values = [...new Set(iris)].filter(s => s !== UNION_GRAPH);
    const instance = new Set<string>(), home = new Map<string, string>(), types = new Map<string, string[]>();
    if (!values.length || !files.length) return { instance, home, types };
    const rows = (await Promise.all(bindings('s', values.map(named)).map(async ({ clause, keep }) => (await port.select(`${PREFIXES} SELECT DISTINCT ?g ?s ?p ?o WHERE {
        VALUES ?p { rdf:type rdfs:label skos:inScheme skos:topConceptOf } GRAPH ?g { ?s ?p ?o } ${clause} }`, files)).filter(r => keep(r.s))))).flat();
    const inModel = new Set<string>(), vocabulary = new Map<string, string[]>();
    for (const { g, s, p, o } of rows) {
        if (p.value === TYPE) (types.get(s.value) ?? types.set(s.value, []).get(s.value)!).push(o.value);
        if (!inShapes(g.value, s)) { if (p.value === TYPE || p.value === LABEL) inModel.add(s.value); continue; }
        if ((p.value === TYPE && SKOS_TYPES.has(o.value)) || SKOS_MEMBERSHIP.has(p.value)) (vocabulary.get(s.value) ?? vocabulary.set(s.value, []).get(s.value)!).push(g.value + '#shapes');
    }
    for (const s of values) {
        const graphs = vocabulary.get(s)?.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        if (inModel.has(s) || graphs) instance.add(s);
        home.set(s, inModel.has(s) ? MODEL : graphs?.[0] ?? MODEL);
    }
    return { instance, home, types };
}

/** The test of factsOf: `s` is a shape subject in the document `doc` (graph name of the closure). */
export function inShapesOf(shapes: ShapesModelRecords): (doc: string, s: Term) => boolean {
    const keys = new Set(shapes.closure.map(q => q.graph.value + ' ' + termKey(q.subject)));
    return (doc, s) => keys.has(doc + ' ' + termKey(s));
}

/** The statements (with their document) whose subject or object is one of `iris`, with an IRI or blank node at the other end, without rdf:type and rdfs:label. */
export async function statementsAround(port: ModelPort, files: string[], iris: string[]): Promise<Row[]> {
    const ask = (end: 's' | 'o') => bindings(end, iris.map(named)).map(async ({ clause, keep }) => (await port.select(`${PREFIXES} SELECT ?g ?s ?p ?o WHERE {
        GRAPH ?g { ?s ?p ?o } FILTER (?p NOT IN (rdf:type, rdfs:label) && !isLiteral(?o)) ${clause} }`, files)).filter(r => keep(r[end])));
    return (await Promise.all([...ask('s'), ...ask('o')])).flat();
}

/**
 * For each instance card of `view`: the number of instances related to it ('in': subjects of its relations, 'out': objects) that the
 * view does not show, or whose relation is hidden; for each placed node shape and each card, the targets or shapes the view does not
 * show. As hiddenNeighborCounts of rdf/scoped-doc.ts. `modelFiles`: the model documents without the manifest.
 */
export async function hiddenNeighborCounts(port: ModelPort, modelFiles: string[], shapes: ShapesModelRecords, view: View): Promise<Map<string, NeighborCount>> {
    const model = shapes.index.model;
    const inShapes = inShapesOf(shapes);
    const cardTerms = boxes(view, 'card').flatMap(b => { const t = elementTerm(b.element); return t?.termType === 'NamedNode' ? [{ b, t }] : []; });
    const placed = new Set(boxes(view, 'card').map(b => b.element));
    const placedIris = new Set(cardTerms.map(c => c.t.value));
    const placedShapes = Object.values(model.nodeShapes).filter(s => placed.has(s.id));
    const candidates = [...placedIris];
    // Independent reads at once: the targets of the placed shapes, the shapes of every card IRI, the statements around every card IRI.
    const [shapeTargets, cardMatches, around] = await Promise.all([
        placedShapes.length ? shapeTargetMatches(port, modelFiles, shapes, { shapes: placedShapes.map(s => s.uri) }) : [],
        candidates.length ? shapeTargetMatches(port, modelFiles, shapes, { nodes: candidates.map(named) }) : [],
        candidates.length && modelFiles.length ? statementsAround(port, modelFiles, candidates) : [],
    ]);
    const targets = shapeTargets.filter(m => m.node.termType === 'NamedNode' && !placedIris.has(m.node.value));
    const others = around.flatMap(r => [r.s.value, r.o.value]);
    const facts = await factsOf(port, modelFiles, inShapes, [...candidates, ...targets.map(m => m.node.value), ...others]);

    const cards = new Map<string, string>();
    for (const { b, t } of cardTerms) if (facts.instance.has(t.value)) cards.set(t.value, b.element);
    const out = new Map<string, NeighborCount>();
    const hiddenOf = new Map<string, number>();
    for (const m of targets) if (facts.instance.has(m.node.value)) hiddenOf.set(m.shape, (hiddenOf.get(m.shape) ?? 0) + 1);
    for (const shape of placedShapes) {
        const n = hiddenOf.get(shape.uri) ?? 0;
        if (n) out.set(shape.id, { in: 0, out: 0, targets: n });
    }
    if (!cards.size) return out;
    const shownIris = new Set<string>(placedIris);
    for (const b of boxes(view, 'card')) for (const m of model.valueSets[b.element]?.members ?? []) shownIris.add(m.uri);
    const placedEdges = new Set(view.edges.filter(e => !e.hidden).map(e => e.relation));
    const neighbors = new Map<string, { in: Set<string>; out: Set<string> }>();
    const consider = (doc: string, subject: Term, p: Term, object: Term, dir: 'in' | 'out') => {
        const [self, other] = dir === 'out' ? [subject, object] : [object, subject];
        if (!cards.has(self.value) || other.termType !== 'NamedNode') return;
        // A relation is a statement of the graph of its subject: the model graph, or the shapes graph of a SKOS subject.
        const owner = facts.home.get(subject.value) ?? MODEL, shapesPart = inShapes(doc, subject);
        if (owner === MODEL ? shapesPart : !shapesPart || doc + '#shapes' !== owner) return;
        if (shownIris.has(other.value) && placedEdges.has(relationId(subject as NamedNode, p as NamedNode, object as NamedNode))) return;
        if (other.value === self.value || !facts.instance.has(other.value)) return;
        const o = neighbors.get(self.value) ?? neighbors.set(self.value, { in: new Set(), out: new Set() }).get(self.value)!;
        o[dir].add(other.value);
    };
    for (const { g, s, p, o } of around) {
        consider(g.value, s, p, o, 'out');
        consider(g.value, s, p, o, 'in');
    }
    for (const [self, id] of cards) { const c = neighbors.get(self); if (c) out.set(id, { in: c.in.size, out: c.out.size }); }
    const shownShapes = new Set(boxes(view, 'card').map(c => c.element));
    const shapeIds = new Map(Object.values(model.nodeShapes).map(s => [s.uri, s.id]));
    const unshown = new Map<string, number>();
    for (const m of cardMatches) {
        if (!cards.has(m.node.value)) continue;
        if (shapeIds.has(m.shape) && !shownShapes.has(shapeIds.get(m.shape)!)) unshown.set(m.node.value, (unshown.get(m.node.value) ?? 0) + 1);
    }
    for (const [uri, id] of cards) {
        const n = unshown.get(uri) ?? 0;
        const row = out.get(id);
        if (n && row) row.targets = n;
        else if (n) out.set(id, { in: 0, out: 0, targets: n });
    }
    return out;
}
