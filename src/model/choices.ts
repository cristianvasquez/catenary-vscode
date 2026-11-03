// Compute halo and entity-group picker choices from workspace quads; adapted from Catenary packages/rdf/src/panel-reads.ts.
import { Choices, neighborChoices, shapeSourceChoices } from '../catenary/model/prompts';
import { elementOfId } from '../catenary/model/doc';
import { authoringMetamodel } from '../catenary/rdf/authoring';
import { shapeTargetChoices } from '../catenary/rdf/link-choices';
import type { ModelGraph } from '../catenary/rdf/graph';
import { elementId } from '../catenary/rdf/ids';
import { scopedDoc } from '../catenary/rdf/scoped-doc';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { buildVocabulary, shapesTriples, vocabularyQuads } from '../catenary/rdf/shapes';
import { rdf } from '../catenary/rdf/terms';
import { readView } from '../catenary/rdf/view-read';
import { isInstance, label } from '../catenary/rdf/vocabulary';
import { graphPrefixes } from './graph-input';

/**
 * Halo expand of `from` (an element or its placement) in `viewId`. 'in', 'out': a node shape, the node shapes with a property to it; an
 * instance, its hidden neighbours. 'targets': a node shape, the instances it checks; an instance, its applicable node shapes.
 */
export function expandChoices(graph: ModelGraph, viewId: string, from: string, dir: 'in' | 'out' | 'targets'): Choices | undefined {
    graphPrefixes(graph);
    const shapes = shapesIndexOf(graph).model;
    if (dir === 'targets') return shapeTargetChoices(graph, scopedDoc({ g: graph, shapes }, { views: [viewId] }), viewId, from);
    const doc = scopedDoc({ g: graph, shapes }, { elements: [from], neighbors: true, views: [viewId] });
    if (shapes.nodeShapes[elementOfId(doc.views[viewId], from)]) return dir === 'in' ? shapeSourceChoices(doc, viewId, from) : undefined;
    const dataset = rdf.dataset([...shapesTriples(graph), ...vocabularyQuads(graph).map(q => rdf.quad(q.subject, q.predicate, q.object))]);
    return neighborChoices(doc, authoringMetamodel(graph, buildVocabulary(dataset, graph.language)), viewId, from, dir);
}

/** IRI -> label of each instance of the workspace graph. Replaces Catenary's instanceLabels (a SPARQL query over its store). */
function instanceLabels(graph: ModelGraph): Map<string, string> {
    const labels = new Map<string, string>(), seen = new Set<string>();
    for (const { subject } of graph.match(null, null, null, graph.union)) {
        if (seen.has(subject.value)) continue;
        seen.add(subject.value);
        if (isInstance(graph, subject)) labels.set(subject.value, label(graph, subject));
    }
    return labels;
}

/** Labels of the instances that are not members of the entity group `collection` of `viewId` (for "+ member"; Catenary panel-reads.ts). */
export function memberOptions(graph: ModelGraph, viewId: string, collection: string): string[] {
    graphPrefixes(graph);
    const view = readView(graph, viewId, shapesIndexOf(graph).model).views[viewId];
    const members = new Set(view?.boxes.find(b => b.kind === 'collection' && b.id === collection)?.kind === 'collection'
        ? (view.boxes.find(b => b.id === collection) as { members: string[] }).members : []);
    return [...new Set([...instanceLabels(graph)].filter(([iri]) => !members.has(elementId(rdf.namedNode(iri)))).map(([, label]) => label))].sort();
}

/** The ids of the instances with the label or IRI `text` (Catenary panel-reads.ts). */
export function instancesNamed(graph: ModelGraph, text: string): string[] {
    return [...instanceLabels(graph)].filter(([iri, label]) => label === text || iri === text).map(([iri]) => elementId(rdf.namedNode(iri)));
}
