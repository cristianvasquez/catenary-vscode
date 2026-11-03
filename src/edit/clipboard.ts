// Lay out the new placements of a paste, over the quads of one view and the model facts: pure, synchronous, no graph, no store.
// Oracle until the cutover: src/catenary/rdf/clipboard.ts.
import type { NamedNode } from '@rdfjs/types';
import { Point } from '../catenary/model/commands';
import { TYPES } from '../catenary/model/diagram-schema';
import { iriId } from '../catenary/model/ids';
import { Classes } from '../catenary/model/metamodel';
import { nkey } from '../catenary/model/notation-graph';
import { layoutPastedBoxes, PasteBox } from '../catenary/model/paste-layout';
import { toSchema } from '../catenary/model/view-schema';
import type { Facts } from './facts';
import { figureTermOf, type FiguresOf } from './figure-edits';
import * as ops from './ops';
import { elementId, elementTerm, V } from './terms';
import { docOfViewQuads } from './view-doc';
import type { ViewQuads } from './view-quads';

/** Layout after arrival, in the paste command. Only new placements (not in `before`) receive positions. Returns the ids of the new placements. */
export function layoutNewPlacements(view: ViewQuads, facts: Facts, figures: FiguresOf, meta: Classes, viewId: string, before: Set<string>, at?: Point, cardScale = 1): string[] {
    const vf = figures(view.graph.value);
    const doc = docOfViewQuads(view, facts, facts.shapes.model);
    const boxes = new Map<string, PasteBox>(doc.views[viewId].boxes.map(b => [b.id, { ...b, group: b.kind === 'group',
        membership: { x: b.x, y: b.y, width: b.width, height: b.height } }]));
    const schema = toSchema(doc, meta, viewId, { violations: [], notation: vf, cardScale });
    for (const child of schema.children ?? []) {
        if (!child.type.startsWith('node:') || child.type === TYPES.LOGIC) continue;
        const direct = elementTerm(child.id);
        const term = figureTermOf(view, facts, child.id);
        const placement = direct && view.has(direct, V.view, view.graph) ? direct : term && ops.nodeOf(view, term);
        if (!placement) continue;
        const id = elementId(placement as NamedNode), position = child.position as Point, size = child.size as { width: number; height: number };
        if (!position || !size) continue;
        const stored = boxes.get(id);
        boxes.set(id, { id, ...position, width: Math.max(stored?.width ?? 0, size.width), height: Math.max(stored?.height ?? 0, size.height),
            group: stored?.group, membership: stored?.membership });
    }
    for (const hub of vf.join.hubs) {
        const p = vf.placed.get(nkey(hub.placedAs))!;
        boxes.set(iriId(p.iri), { id: iriId(p.iri), x: p.x ?? 0, y: p.y ?? 0, width: 40, height: 40 });
    }
    const added = [...boxes.values()].filter(b => !before.has(b.id)), fixed = [...boxes.values()].filter(b => before.has(b.id));
    const anchor = at ?? { x: Math.min(...added.map(b => b.x)), y: Math.min(...added.map(b => b.y)) };
    for (const b of layoutPastedBoxes(added, fixed, anchor)) {
        // Preserve dimensions and appearance. Drawn extents reserve space but are not stored as new sizes.
        ops.writeBox(view, facts, elementTerm(b.id)!, { x: b.x, y: b.y });
    }
    return [...vf.placed.values()].filter(p => !before.has(iriId(p.iri))).map(p => iriId(p.iri));
}
