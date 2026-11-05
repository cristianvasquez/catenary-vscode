// Hidden-neighbour counts of the cards of a view from the kept answer of the view; the target badges from one count query each.
import type { Term } from '@rdfjs/types';
import { type View, boxes } from '../catenary/model/doc';
import { NS } from '../catenary/model/terms';
import { UNION_GRAPH, dataGraphIri } from '../catenary/rdf/files';
import { relationIdOf } from '../catenary/model/ids';
import type { NQuad, NTerm } from '../catenary/model/notation-graph';
import { nkey } from '../catenary/model/notation-graph';
import { termToJSON } from '../catenary/model/terms';
import { elementTerm } from '../catenary/rdf/ids';
import { termKey } from '../catenary/rdf/terms';
import type { FocusNode } from '../catenary/shacl/common/index';
import type { ModelPort, Row } from '../model/port';
import type { ShapesModelRecords } from './shapes';
import { bindings, targetBadges, type TargetBadges } from './targets';
import type { ModelContext } from './diagram';
import { answerCovers, type KeptPrefetch } from './figures';
import { byDocumentKind, documentSets, type DocumentRow, type DocumentSets } from './documents';

/** The hidden neighbours of a card: statements in and out, and the instances that its shape targets. */
export type NeighborCount = { in: number; out: number; targets?: number };

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${NS.skos}>`;
const TYPE = NS.rdf + 'type', LABEL = NS.rdfs + 'label';
const SKOS_TYPES = new Set(['ConceptScheme', 'Concept', 'Collection'].map(t => NS.skos + t));
const SKOS_MEMBERSHIP = new Set(['inScheme', 'topConceptOf'].map(p => NS.skos + p));
/** The home of a subject in the model graph (homeOf of rdf/vocabulary.ts). */
const MODEL = '';
/** The IRI prefix of a blank node in a port answer. */
const BLANK = 'urn:skolem:blank:';

const named = (value: string): FocusNode => ({ termType: 'NamedNode', value });

/**
 * The instance test and the home of each IRI (instancesAmong, homesAmong of rdf/quad-read.ts): rdf:type, rdfs:label and the SKOS membership
 * statements by document kind. A shape subject's statement from shapes documents belongs to shapes; its home is the first shapes document
 * by path, as `<file URI>#shapes`. `types`: the rdf:type objects of each IRI across both document kinds.
 */
export async function factsOf(port: ModelPort, files: string[], inShapes: InShapes, iris: Iterable<string>): Promise<{ instance: Set<string>; home: Map<string, string>; types: Map<string, string[]> }> {
    const values = [...new Set(iris)].filter(s => s !== UNION_GRAPH);
    const instance = new Set<string>(), home = new Map<string, string>(), types = new Map<string, string[]>();
    if (!values.length || !files.length) return { instance, home, types };
    const rows = (await Promise.all(bindings('s', values.map(named)).map(({ clause }) => byDocumentKind(port, inShapes.sets(files), `${PREFIXES} SELECT DISTINCT ?s ?p ?o WHERE {
        VALUES ?p { rdf:type rdfs:label skos:inScheme skos:topConceptOf } ?s ?p ?o ${clause} }`)))).flat();
    const inModel = new Set<string>(), vocabulary = new Map<string, string[]>();
    for (const r of rows) {
        const { s, p, o } = r, doc = inShapes.documentOf(r);
        if (p.value === TYPE) (types.get(s.value) ?? types.set(s.value, []).get(s.value)!).push(o.value);
        if (!inShapes(r.kind, s)) { if (p.value === TYPE || p.value === LABEL) inModel.add(s.value); continue; }
        if ((p.value === TYPE && SKOS_TYPES.has(o.value)) || SKOS_MEMBERSHIP.has(p.value)) (vocabulary.get(s.value) ?? vocabulary.set(s.value, []).get(s.value)!).push(dataGraphIri(doc!) + '#shapes');
    }
    for (const s of values) {
        const graphs = vocabulary.get(s)?.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        if (inModel.has(s) || graphs) instance.add(s);
        home.set(s, inModel.has(s) ? MODEL : graphs?.[0] ?? MODEL);
    }
    return { instance, home, types };
}

/** Classify by document kind; use the first shapes document by path only when a subject needs a home. */
export interface InShapes {
    (kind: DocumentRow['kind'], s: Term): boolean;
    documentOf(r: Row): string | undefined;
    sets(files: string[]): DocumentSets;
}

export function inShapesOf(shapes: ShapesModelRecords): InShapes {
    const docs = new Map<string, string>();
    for (const [file, subjects] of [...shapes.shapeSubjectsByFile].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        for (const subject of subjects) if (!docs.has(subject)) docs.set(subject, file);
    }
    return Object.assign((kind: DocumentRow['kind'], s: Term) => kind === 'shapes' && shapes.shapeSubjects.has(termKey(s)),
        { documentOf: (r: Row) => docs.get(termKey(r.s)), sets: (files: string[]) => documentSets(shapes, files) });
}

/** The placed node shapes (their IRIs) and the IRIs of the cards of `view`. */
function placedOf(shapes: ShapesModelRecords, view: View): { placedShapes: string[]; placedIris: string[] } {
    const placed = new Set(boxes(view, 'card').map(b => b.element));
    const placedIris = boxes(view, 'card').flatMap(b => { const t = elementTerm(b.element); return t?.termType === 'NamedNode' ? [t.value] : []; });
    return { placedShapes: Object.values(shapes.index.model.nodeShapes).filter(s => placed.has(s.id)).map(s => s.uri), placedIris: [...new Set(placedIris)] };
}

/** The target badges of `view` (targetBadges of targets.ts): at most two queries. */
export function viewBadges(ctx: Pick<ModelContext, 'port' | 'modelFiles' | 'shapes'>, view: View): Promise<TargetBadges> {
    const { placedShapes, placedIris } = placedOf(ctx.shapes, view);
    return targetBadges(ctx.port, ctx.modelFiles, ctx.shapes, placedShapes, placedIris);
}

const VIEW_NAMESPACES = [NS.view, 'osg://vocab/view#'];
const isView = (value: string) => VIEW_NAMESPACES.some(ns => value.startsWith(ns));
/** A statement key for the shapes test: a blank object as `_` (the port names blank nodes per request; the closure has its own names). */
const shapeKey = (s: string, p: string, o: NTerm) => `${s} ${p} ${o.termType === 'NamedNode' && o.value.startsWith(BLANK) ? '_' : nkey(o)}`;
const closureKeys = new WeakMap<ShapesModelRecords, Set<string>>();
function closureOf(shapes: ShapesModelRecords): Set<string> {
    let keys = closureKeys.get(shapes);
    if (!keys) closureKeys.set(shapes, keys = new Set(shapes.closure.flatMap(q => {
        const o = termToJSON(q.object);
        return q.subject.termType === 'NamedNode' && o ? [shapeKey(q.subject.value, q.predicate.value, o)] : [];
    })));
    return keys;
}

/** The card IRIs of `view` whose statements `answer` has not read in both directions (with the types and labels of the other ends). */
export function neighborMisses(shapes: ShapesModelRecords, view: View, answer: KeptPrefetch): string[] {
    return placedOf(shapes, view).placedIris.filter(iri => !iri.startsWith(BLANK) && !answerCovers(answer, iri));
}

/**
 * For each IRI card of `view`: the number of related IRIs ('in': subjects, 'out': objects) that the view does not show, or whose relation
 * is hidden; from `answer`, the kept answer of the view (it sends no query). Blank nodes and view-file subjects are excluded.
 * A statement of a shape subject in the closure belongs to the shapes. `badges` (viewBadges): the targets
 * of each placed node shape and the shapes of each card that the view does not show.
 */
export function hiddenNeighborCounts(ctx: Pick<ModelContext, 'shapes' | 'views'>, view: View, answer: KeptPrefetch, badges?: TargetBadges): Map<string, NeighborCount> {
    const { shapes, views } = ctx, model = shapes.index.model, closure = closureOf(shapes);
    const out = new Map<string, NeighborCount>();
    const shapesPart = (q: NQuad) => !q.subject.value.startsWith(BLANK) && shapes.shapeSubjects.has(`<${q.subject.value}>`) && closure.has(shapeKey(q.subject.value, q.predicate, q.object));
    // The statements of the answer by subject, without the subjects of a view file (a view, a placement, a mark).
    const bySubject = new Map<string, NQuad[]>();
    for (const q of answer.quads) (bySubject.get(q.subject.value) ?? bySubject.set(q.subject.value, []).get(q.subject.value)!).push(q);
    const viewSubjects = new Set(views.keys());
    for (const [s, qs] of bySubject) if (qs.some(q => q.predicate === TYPE && isView(q.object.value))) viewSubjects.add(s);
    for (const s of viewSubjects) bySubject.delete(s);
    const inModel = (s: string) => (bySubject.get(s) ?? []).some(q => (q.predicate === TYPE || q.predicate === LABEL) && !shapesPart(q));
    const vocabulary = (s: string) => (bySubject.get(s) ?? []).some(q => shapesPart(q) && ((q.predicate === TYPE && SKOS_TYPES.has(q.object.value)) || SKOS_MEMBERSHIP.has(q.predicate)));

    const cards = new Map<string, string>();
    for (const b of boxes(view, 'card')) {
        const t = elementTerm(b.element);
        if (t?.termType === 'NamedNode' && !t.value.startsWith(BLANK) && t.value !== UNION_GRAPH && !viewSubjects.has(t.value)) cards.set(t.value, b.element);
    }
    const shownIris = new Set(placedOf(shapes, view).placedIris);
    for (const b of boxes(view, 'card')) for (const m of model.valueSets[b.element]?.members ?? []) shownIris.add(m.uri);
    const placedEdges = new Set(view.edges.filter(e => !e.hidden).map(e => e.relation));
    const neighbors = new Map<string, { in: Set<string>; out: Set<string> }>();
    const consider = (q: NQuad, dir: 'in' | 'out') => {
        const [self, other] = dir === 'out' ? [q.subject, q.object] : [q.object, q.subject];
        if (!cards.has(self.value) || other.termType !== 'NamedNode' || other.value === self.value) return;
        // A relation is a statement of the graph of its subject: the model graph, or the shapes graph of a SKOS subject.
        const s = q.subject.value, shapesHome = !s.startsWith(BLANK) && !inModel(s) && vocabulary(s);
        if (shapesHome !== shapesPart(q)) return;
        if (shownIris.has(other.value) && placedEdges.has(relationIdOf(s, q.predicate, q.object.value))) return;
        if (other.value.startsWith(BLANK) || viewSubjects.has(other.value)) return;
        const o = neighbors.get(self.value) ?? neighbors.set(self.value, { in: new Set(), out: new Set() }).get(self.value)!;
        o[dir].add(other.value);
    };
    for (const [, qs] of bySubject) for (const q of qs) {
        if (q.predicate === TYPE || q.predicate === LABEL || isView(q.predicate) || q.object.termType !== 'NamedNode' || views.has(q.object.value)) continue;
        consider(q, 'out');
        consider(q, 'in');
    }
    // The rows of the placed shapes first (model order), then the cards (a card that is also a placed shape keeps its place, not its badge).
    for (const shape of Object.values(model.nodeShapes)) {
        const n = badges?.shapes.get(shape.uri) ?? 0;
        if (n) out.set(shape.id, { in: 0, out: 0, targets: n });
    }
    for (const [self, id] of cards) { const c = neighbors.get(self); if (c) out.set(id, { in: c.in.size, out: c.out.size }); }
    if (!badges) return out;
    for (const [iri, id] of cards) {
        const n = badges.nodes.get(iri) ?? 0;
        const row = out.get(id);
        if (n && row) row.targets = n;
        else if (n) out.set(id, { in: 0, out: 0, targets: n });
    }
    return out;
}
