// Lay out newly placed boxes after a paste or insertion; adapted from Catenary packages/rdf/src/clipboard.ts.
import type { NamedNode } from '@rdfjs/types';
import { Point } from '../model/commands';
import { TYPES } from '../model/diagram-schema';
import { iriId } from '../model/ids';
import { Classes } from '../model/metamodel';
import { nkey } from '../model/notation-graph';
import { layoutPastedBoxes, PasteBox } from '../model/paste-layout';
import { toSchema } from '../model/view-schema';
import { figureTermOf } from './figure-edits';
import { ModelGraph } from './graph';
import { elementId, elementTerm } from './ids';
import { viewFiguresOf } from './notations';
import * as ops from './ops';
import { rdf } from './terms';
import { readView } from './view-read';
import { nodeOf, V } from './views';

/** Layout after arrival, inside the paste transaction. Only new placements receive positions. */
export function layoutNewPlacements(g: ModelGraph, meta: Classes, viewId: string, before: Set<string>, at?: Point, cardScale = 1): string[] {
    const view = ops.viewTerm(g, viewId)!;
    const vf = viewFiguresOf(g, view.value);
    const doc = readView(g, viewId);
    const boxes = new Map<string, PasteBox>(doc.views[viewId].boxes.map(b => [b.id, { ...b, group: b.kind === 'group',
        membership: { x: b.x, y: b.y, width: b.width, height: b.height } }]));
    const schema = toSchema(doc, meta, viewId, { violations: [], notation: vf, cardScale });
    for (const child of schema.children ?? []) {
        if (!child.type.startsWith('node:') || child.type === TYPES.LOGIC) continue;
        const direct = elementTerm(child.id);
        const term = figureTermOf(g, child.id, view);
        const placement = direct && g.has(rdf.quad(direct, V.view, view, view)) ? direct : term && nodeOf(g, view, term);
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
        const p = elementTerm(b.id)!;
        // Preserve dimensions and appearance. Drawn extents reserve space but are not stored as new sizes.
        ops.writeBox(g, view, p, { x: b.x, y: b.y });
    }
    return [...vf.placed.values()].filter(p => !before.has(iriId(p.iri))).map(p => iriId(p.iri));
}
