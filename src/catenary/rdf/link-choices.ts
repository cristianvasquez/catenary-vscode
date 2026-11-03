// Compute applicable-shape and checked-instance halo choices; adapted from Catenary packages/rdf/src/link-choices.ts.
// Choices place existing elements only; no relation creation is exposed.
import type { Choices } from '../model/prompts';
import { Doc, boxes, elementOfId } from '../model/doc';
import { shortIri } from '../model/shapes-doc';
import { reasonText } from '../shacl/common';
import { ModelGraph } from './graph';
import { elementId } from './ids';
import { labels } from './quad-read';
import { shapeTargetMatches } from './shacl-targets';
import { rdf } from './terms';
import { isInstance } from './vocabulary';

/** Unshown instances for a shape, or unshown applicable shapes for an instance. */
export function shapeTargetChoices(g: ModelGraph, doc: Doc, viewId: string, from: string): Choices | undefined {
    const view = doc.views[viewId];
    if (!view) return undefined;
    const element = elementOfId(view, from);
    const shown = new Set(boxes(view, 'card').map(card => card.element));
    const shape = doc.shapes.nodeShapes[element];
    if (shape) {
        const matches = shapeTargetMatches(g, { shapes: [shape.uri] }).filter(m => m.node.termType === 'NamedNode'
            && isInstance(g, rdf.namedNode(m.node.value)) && !shown.has(elementId(rdf.namedNode(m.node.value))));
        if (!matches.length) return undefined;
        const names = labels(g, matches.map(m => m.node.value));
        return {
            title: `${shape.label}: instances (${matches.length} not in the view)`,
            items: matches.map(m => ({ label: names.get(m.node.value) ?? shortIri(m.node.value),
                description: reasonText(m.reasons, shortIri), ids: [elementId(rdf.namedNode(m.node.value))] }))
                .sort((a, b) => a.label.localeCompare(b.label) || a.ids[0].localeCompare(b.ids[0]))
        };
    }
    const instance = doc.instances[element];
    if (!instance) return undefined;
    const matches = shapeTargetMatches(g, { nodes: [{ termType: 'NamedNode', value: instance.uri }] });
    const shapes = matches.flatMap(match => {
        const shape = Object.values(doc.shapes.nodeShapes).find(s => s.uri === match.shape);
        return shape && !shown.has(shape.id) ? [{ ...shape, reasons: match.reasons }] : [];
    });
    if (!shapes.length) return undefined;
    return {
        title: `${instance.label}: applicable node shapes (${shapes.length} not in the view)`,
        items: shapes.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
            .map(shape => ({ label: shape.label, description: reasonText(shape.reasons, shortIri), ids: [shape.id] }))
    };
}
