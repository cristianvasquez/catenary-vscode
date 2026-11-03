// Read labels, memberships, types and diagnostics over quads; adapted from Catenary packages/rdf/src/sparql.ts.
import type { NamedNode, Term } from '@rdfjs/types';
import { LABEL_PREDICATES, pickLabel } from '../model/labels';
import { NS } from '../model/terms';
import type { ModelGraph } from './graph';
import { REPORT_GRAPH, UNION_GRAPH } from './graph-names';
import { rdf } from './terms';
import { P, SKOS_MEMBERSHIP, SKOS_TYPES, homeOf, labelFromIri, labelLiterals } from './vocabulary';

/** One described thing and its types, without the SPARQL store dependency. */
export function thingHead(g: ModelGraph, t: NamedNode): { label: string; types: string[] } | undefined {
    const quads = g.match(t).filter(q => q.graph.value !== REPORT_GRAPH);
    if (!quads.length) return undefined;
    const types = [...new Set(quads.filter(q => q.predicate.equals(P.type)).map(q => q.object.value))].sort();
    return { label: labels(g, [t.value]).get(t.value)!, types };
}

export function inModelAmong(g: ModelGraph, iris: Iterable<string>): Set<string> {
    return new Set([...new Set(iris)].filter(s => s !== g.union.value &&
        [P.type, P.label].some(p => g.match(rdf.namedNode(s), p, null, g.union).length > 0)));
}

export function instancesAmong(g: ModelGraph, iris: Iterable<string>): Set<string> {
    const values = [...new Set(iris)].filter(s => s !== g.union.value && s !== UNION_GRAPH);
    const out = inModelAmong(g, values);
    for (const s of values) if (!out.has(s)) {
        const t = rdf.namedNode(s);
        if (g.shapesGraphs().some(graph => SKOS_TYPES.some(type => g.match(t, P.type, type, graph).length > 0)
            || SKOS_MEMBERSHIP.some(p => g.match(t, p, null, graph).length > 0))) out.add(s);
    }
    return out;
}

export function homesAmong(g: ModelGraph, iris: Iterable<string>): Map<string, string> {
    return new Map([...new Set(iris)].map(s => [s, homeOf(g, rdf.namedNode(s)).value]));
}

export function labels(g: ModelGraph, iris: string[]): Map<string, string> {
    return new Map(iris.map(s => {
        const quads = g.match(rdf.namedNode(s)).filter(q => q.graph.value !== REPORT_GRAPH);
        const paths = quads.filter(q => q.predicate.value === NS.sh + 'path' && !q.object.value.startsWith('urn:skolem:'))
            .map(q => q.object.value).sort();
        const objects = (p: string): Term[] => quads.filter(q => q.predicate.value === p).map(q => q.object);
        return [s, pickLabel(labelLiterals(p => LABEL_PREDICATES.includes(p as typeof LABEL_PREDICATES[number]) ? objects(p) : []), g.language)
            ?? labelFromIri(paths[0] ?? s)];
    }));
}
