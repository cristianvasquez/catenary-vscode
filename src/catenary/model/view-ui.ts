// Compute view-only gesture targets on the backend; adapted from Catenary packages/model/src/view-ui.ts.
// The frontend sends candidate ids and receives refusal reasons; it keeps no read model.

import { Rect, arrowProblem } from './commands';
import { Doc, View, ViewBox, boxOf, cardOf } from './doc';
import { NodeShape, PropertyShape, ValueSet } from './shapes-doc';

/** A gesture of a view editor and the ids of its candidate targets, as the canvas finds them (card: its element id). */
export type ViewGesture =
    /** Arrow button of a note. */
    | { kind: 'arrow'; source: string; boxes: string[] }
    /** No targets: the facts of one element. */
    | { kind: 'element'; id: string };

/** Lists of candidate targets of a gesture. */
export type TargetList = 'cards' | 'boxes' | 'concepts' | 'ids';

export interface GestureInfo {
    /** Per list, per candidate id: why it is not a target; '': it is one. */
    problems: Partial<Record<TargetList, Record<string, string>>>;
    /** The element of the gesture (source, relation, row, property, id): its stored box in the view (a card by its element id). */
    box?: ViewBox;
    property?: PropertyShape;
    nodeShape?: NodeShape;
    valueSet?: ValueSet;
    /** The stored box of the card of the node shape of `property` in the view. */
    ownerBox?: Rect;
}

/** The main element of a gesture. */
function subjectOf(g: ViewGesture): string | undefined {
    switch (g.kind) {
        case 'arrow': return g.source;
        case 'element': return g.id;
    }
}

/**
 * The problems of the candidate targets of gesture `g` in `view` (the stored view), with the rules that the canvas used: the same
 * functions on the read model `doc` of the gesture elements and the view (PanelReads.viewGesture). An undefined problem is ''.
 */
export function viewGesture(doc: Doc, view: View | undefined, g: ViewGesture): GestureInfo {
    const { shapes } = doc;
    const each = (ids: string[], problem: (id: string) => string | undefined) => Object.fromEntries(ids.map(id => [id, problem(id) ?? '']));
    const arrow = (from: string) => (to: string) => view && to ? arrowProblem(view, from, to) : 'An arrow connects two elements of the view.';
    const problems: GestureInfo['problems'] = {};
    switch (g.kind) {
        case 'arrow':
            problems.boxes = each(g.boxes, arrow(g.source));
            break;
        case 'element':
            break;
    }
    const id = subjectOf(g);
    if (id === undefined) return { problems };
    const property = shapes.properties[id];
    const ownerBox = property && cardOf(view, property.owner);
    const box = boxOf(view, id) ?? cardOf(view, id);
    return {
        problems, ...(box ? { box } : {}), ...(property ? { property } : {}), ...(shapes.nodeShapes[id] ? { nodeShape: shapes.nodeShapes[id] } : {}),
        ...(shapes.valueSets[id] ? { valueSet: shapes.valueSets[id] } : {}),
        ...(ownerBox ? { ownerBox: { x: ownerBox.x, y: ownerBox.y, width: ownerBox.width, height: ownerBox.height } } : {})
    };
}
