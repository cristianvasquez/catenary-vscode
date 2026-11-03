// Normalize legacy Catenary terms and placements on read; adapted from Catenary packages/rdf/src/loader.ts.
import { NS, publishedIri } from '../model/terms';
import type { Quad, Term } from '@rdfjs/types';
import { isSkolem } from '../rdf-core/skolem';
import { mapTerm, termKey } from '../rdf-files/terms';
import { rdf } from './terms';
import { V } from './views';
import { P } from './vocabulary';


/**
 * The quads with each term in an old Catenary namespace replaced by its published term
 * (LEGACY_NAMESPACES in model/terms.ts). The graph names stay. `changed`: a quad had such a term.
 */
export function readLegacy(quads: Quad[]): { quads: Quad[]; changed: boolean } {
    let changed = false;
    const map = <T extends Term>(t: T): T => mapTerm(t, y => {
        if (y.termType !== 'NamedNode') return y;
        const iri = publishedIri(y.value);
        if (iri === y.value) return y;
        changed = true;
        return rdf.namedNode(iri);
    });
    const out = quads.map(q => rdf.quad(map(q.subject), map(q.predicate), map(q.object), q.graph));
    return { quads: changed ? out : quads, changed };
}


/**
 * Why the quads of a view file are not a view, or undefined. A view file has one named graph `G` and no statements outside it; `G`
 * is the only view:View. Each placement has one `view:view G`. A view places an element (view:element) or a triple (rdf:reifies) once.
 */
export function viewProblem(quads: Quad[]): string | undefined {
    const graphs = rdf.termSet(quads.map(q => q.graph));
    if (graphs.size !== 1 || quads[0].graph.termType !== 'NamedNode') return `a view file has one named graph, the view; it has ${graphs.size} graph(s)${[...graphs].some(g => g.termType === 'DefaultGraph') ? ', with the default graph' : ''}`;
    const g = quads[0].graph;
    const views = rdf.termSet(quads.filter(q => q.predicate.equals(P.type) && q.object.equals(V.View)).map(q => q.subject));
    if (views.size !== 1 || ![...views][0].equals(g)) return `the graph <${g.value}> must contain exactly one view:View, <${g.value}> itself; found ${[...views].map(v => `<${v.value}>`).join(', ') || 'none'}`;
    const placed = new Map<string, string>();
    for (const p of quads.filter(q => q.predicate.equals(P.type) && q.object.equals(V.Placement)).map(q => q.subject)) {
        const name = `<${p.value}>`;
        const of = quads.filter(q => q.subject.equals(p) && q.predicate.equals(V.view)).map(q => q.object);
        if (of.length !== 1 || !of[0].equals(g)) return `${name} needs one view:view <${g.value}>; it has ${of.map(o => `<${o.value}>`).join(', ') || 'none'}`;
        for (const q of quads.filter(q => q.subject.equals(p) && (q.predicate.equals(V.element) || q.predicate.equals(P.reifies)))) {
            const k = termKey(q.object), other = placed.get(k);
            if (other) return `${other} and ${name} place the same ${q.object.termType === 'Quad' ? 'triple' : 'element'}; a view places it once`;
            placed.set(k, name);
        }
    }
    return undefined;
}


const SH_TYPES = new Set(['NodeShape', 'PropertyShape', 'Shape'].map(t => NS.sh + t));


/**
 * The subjects of the shapes of a file (termKey): subjects with a statement in the sh: namespace (a predicate, or rdf:type sh:…), and
 * the nodes below them that were blank nodes in a file (skolem IRIs: nested shapes, paths) and the RDF list cells below them.
 */
export function shapePart(quads: Quad[]): Set<string> {
    const bySubject = new Map<string, Quad[]>();
    for (const q of quads) (bySubject.get(termKey(q.subject)) ?? bySubject.set(termKey(q.subject), []).get(termKey(q.subject))!).push(q);
    const out = new Set<string>();
    const isCell = (k: string) => (bySubject.get(k) ?? []).some(q => q.predicate.value === NS.rdf + 'first');
    const visit = (k: string) => {
        if (out.has(k)) return;
        out.add(k);
        for (const q of bySubject.get(k) ?? []) {
            const o = termKey(q.object);
            // A nested node, or an RDF list cell (sh:or, sh:in).
            if (isSkolem(q.object) || (q.object.termType === 'NamedNode' && isCell(o))) visit(o);
        }
    };
    for (const [k, qs] of bySubject) {
        if (qs.some(q => q.predicate.value.startsWith(NS.sh) || (q.predicate.equals(P.type) && SH_TYPES.has(q.object.value)))) visit(k);
    }
    // A list cell that no shape refers to (left by earlier saves) whose item or next cell is shape content: shape content too.
    for (let changed = true; changed;) {
        changed = false;
        for (const [k, qs] of bySubject) {
            if (out.has(k) || !isCell(k)) continue;
            if (qs.some(q => (q.predicate.value === NS.rdf + 'first' || q.predicate.value === NS.rdf + 'rest') && out.has(termKey(q.object)))) { visit(k); changed = true; }
        }
    }
    return out;
}

