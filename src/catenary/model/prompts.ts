// Compute halo expansion choices on the backend; adapted from Catenary packages/model/src/prompts.ts.
// The frontend receives picker items, not the read model.

import { Doc, Relation, boxShowing, elementOfId, hiddenNeighbors } from './doc';
import { Classes, predicateName } from './metamodel';
import { PropertyShape, formatPath } from './shapes-doc';
import { hiddenShapeSources } from './shapes-schema';

/** An item of a picker: its label, description, and the element ids that it acts on. */
interface ChoiceItem {
    label: string;
    description?: string;
    ids: string[];
}

/** The items of a picker and its title. */
export interface Choices {
    title: string;
    items: ChoiceItem[];
}

/**
 * Halo expand button of an instance card: related instances (dir 'in': subjects; 'out': objects) that are not shown, or have a hidden
 * relation to `from`. Each item: the relations to show. Undefined: no hidden neighbour or relation.
 */
export function neighborChoices(doc: Doc, meta: Classes, viewId: string, from: string, dir: 'out' | 'in'): Choices | undefined {
    const view = doc.views[viewId];
    const self = doc.instances[elementOfId(view, from)];
    if (!self) return undefined;
    const hidden = hiddenNeighbors(doc, view, self.id, dir);
    if (!hidden.length) return undefined;
    const names = (rs: Relation[]) => [...new Set(rs.map(r => predicateName(meta, r.predicate)))].sort().map(n => dir === 'out' ? `${n} →` : `← ${n}`).join(', ');
    return {
        title: `${self.label}: ${dir === 'out' ? 'outgoing' : 'incoming'} (${hidden.length} hidden)`,
        items: hidden.map(n => ({ label: n.instance.label, description: names(n.relations) + (boxShowing(doc, view, n.instance.id) !== undefined ? ' (in the view)' : ''), ids: n.relations.map(r => r.id) }))
    };
}

/** Halo incoming button of a node shape card: the node shapes with a property to `from` that the view does not show. Item ids: the node shape. */
export function shapeSourceChoices(doc: Doc, viewId: string, from: string): Choices | undefined {
    const view = doc.views[viewId];
    const id = elementOfId(view, from);
    const self = doc.shapes.nodeShapes[id];
    if (!self) return undefined;
    const hidden = hiddenShapeSources(doc.shapes, view, id);
    if (!hidden.length) return undefined;
    const names = (ps: PropertyShape[]) => [...new Set(ps.map(p => p.name ?? formatPath(p.path)))].sort().map(n => `← ${n}`).join(', ');
    return {
        title: `${self.label}: incoming (${hidden.length} not in the view)`,
        items: hidden.map(n => ({ label: n.shape.label, description: names(n.properties) || 'sh:node', ids: [n.shape.id] }))
    };
}

