// The model facts of the old graph, for the oracle comparison of src/edit/ops.ts with src/catenary/rdf/ops.ts. Goes with the old pipeline (K11).
import type { Term } from '@rdfjs/types';
import type { ModelGraph } from '../src/catenary/rdf/graph';
import { elementTerm } from '../src/catenary/rdf/ids';
import { shapesCardTerm, shapesIndexOf } from '../src/catenary/rdf/shapes-read';
import { rdf } from '../src/catenary/rdf/terms';
import { isView } from '../src/catenary/rdf/views';
import { homeOf, isInstance, label, P } from '../src/catenary/rdf/vocabulary';
import type { Facts } from '../src/edit/facts';

export function factsFromGraph(g: ModelGraph): Facts {
    const n = (iri: string) => rdf.namedNode(iri);
    // An instance as placeConnectors of rdf/ops.ts reads it: rdf:type or rdfs:label in the model.
    const typedOrLabelled = (t: Term) => t.termType === 'NamedNode' && (g.match(t, P.type, null, g.union).length > 0 || g.match(t, P.label, null, g.union).length > 0);
    return {
        shapes: shapesIndexOf(g),
        isInstance: iri => isInstance(g, n(iri)),
        label: iri => label(g, n(iri)),
        isView: iri => isView(g, n(iri)),
        viewLabel: iri => label(g, n(iri), n(iri)),
        has: (s, p, o) => g.has(rdf.quad(n(s), n(p), n(o), homeOf(g, n(s)))),
        shapesCard: id => {
            const t = elementTerm(id);
            return t && g.match(t).some(q => g.isShapesGraph(q.graph)) ? shapesCardTerm(g, id) : undefined;
        },
        statementsAmong: iris => {
            const among = new Set(iris);
            return iris.flatMap(s => g.match(n(s), null, null, g.union))
                .filter(q => among.has(q.object.value) && !q.predicate.equals(P.type) && !q.predicate.equals(P.label) && typedOrLabelled(q.subject) && typedOrLabelled(q.object))
                .map(q => rdf.quad(q.subject, q.predicate, q.object));
        }
    };
}
