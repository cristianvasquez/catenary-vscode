// Configure graph rules, caches and view detection; adapted from Catenary packages/rdf/src/model-graph.ts.
import type { QuadStore } from '../rdf-files/store';
import type { Quad, Term } from '@rdfjs/types';
import { NS } from '../model/terms';
import { REPORT_GRAPH } from './graph-names';
import { CATENARY_GRAPH_NAMES } from './graph-names';
import { GraphRules } from '../rdf-core/graph';
import { ModelGraph } from './graph';
import { isView, views } from './views';
import { metamodelQuad } from './vocabulary';


// Only the graph-cache rules from change.ts are needed on the read path.
const LAYOUT_PREDICATES = new Set(['x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide', 'vertices'].map(p => NS.view + p));
interface GraphFacts {
    isDataGraph(t: Pick<Term, 'termType' | 'value'> | undefined): boolean;
    isShapesGraph(t: Term | undefined): boolean;
    isView(t: Term | undefined): boolean;
    metamodelQuad(q: Quad): boolean;
}
interface QuadChange { op: 'add' | 'remove'; quad: Quad }
interface Dependencies { shapes: boolean; query: boolean; data: boolean; persisted: boolean }
type QuadKind = 'report' | 'shapes' | 'metamodel' | 'data' | 'layout' | 'view' | 'other';
function quadKind(facts: GraphFacts, q: Quad): QuadKind {
    if (q.graph.value === REPORT_GRAPH) return 'report';
    if (facts.isShapesGraph(q.graph)) return 'shapes';
    if (facts.isDataGraph(q.graph)) return facts.metamodelQuad(q) ? 'metamodel' : 'data';
    if (!facts.isView(q.graph)) return 'other';
    return LAYOUT_PREDICATES.has(q.predicate.value) ? 'layout' : 'view';
}
function quadDependencies(facts: GraphFacts, q: Quad): Dependencies {
    const kind = quadKind(facts, q);
    const declaresView = q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'View';
    return {
        persisted: kind !== 'report',
        data: kind !== 'report' && kind !== 'layout',
        query: kind !== 'report' && kind !== 'layout' && (kind !== 'view' || declaresView),
        shapes: kind === 'shapes' || kind === 'metamodel'
    };
}
function layoutOnly(graph: GraphFacts, patch: readonly QuadChange[]): boolean {
    const facts = memoized(graph);
    return patch.length > 0 && patch.every(c => quadKind(facts, c.quad) === 'layout');
}
function memoized(facts: GraphFacts): GraphFacts {
    const views = new Map<string, boolean>();
    return {
        isDataGraph: t => facts.isDataGraph(t),
        isShapesGraph: t => facts.isShapesGraph(t),
        isView: t => { const k = t?.value ?? ''; let v = views.get(k); if (v === undefined) views.set(k, v = facts.isView(t)); return v; },
        metamodelQuad: q => facts.metamodelQuad(q)
    };
}

const CATENARY_RULES: GraphRules = { isView, views, metamodelQuad, dependencies: quadDependencies, layoutOnly };


export function newModelGraph(store: QuadStore): ModelGraph {
    return new ModelGraph(store, CATENARY_RULES, CATENARY_GRAPH_NAMES);
}

