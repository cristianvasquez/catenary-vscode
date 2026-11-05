// View records, geometry and membership queries; adapted from Catenary packages/model/src/doc.ts.
import { ShapesModel, emptyShapes } from './shapes-doc';
import { TermJSON } from './terms';


export type Side = 'top' | 'right' | 'bottom' | 'left';

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];


export const DEFAULT_SIZE = { width: 640, height: 320 };

export const DEFAULT_NOTE_SIZE = { width: 320, height: 180 };

export const DEFAULT_VIEW_REFERENCE_SIZE = { width: 280, height: 96 };

export const DEFAULT_COLLECTION_SIZE = { width: 320, height: 240 };

/** Size of a group without width or height in the file. Cards without a size get DEFAULT_SIZE. */
export const GROUP_SIZE = { width: 400, height: 300 };


export type Box = { x: number; y: number; width: number; height: number };


export interface Instance {
    id: string;
    label: string;
    types: string[];                         // rdf:type IRIs, sorted
    uri: string;                             // IRI
    fields: Record<string, TermJSON[]>;      // predicate IRI -> values (IRIs of instances are relations, not fields)
    file?: string;                           // the file with most of its statements
}


export interface Relation {
    id: string;
    subject: string;     // instance id
    predicate: string;   // IRI
    object: string;      // instance id
}


export type CardDisplay = 'simple' | 'shaped' | 'detailed';


/** The fields of every box of a view. */
interface BoxBase extends Box {
    id: string;
    color?: string;
}


/**
 * The card of an element in a view. `id`: the id of its placement (a placement is not its element).
 * `element`: instance id; in a shapes view also node shape, value set, or property shape taken out of its card (its pill).
 */
export interface ViewCard extends BoxBase {
    kind: 'card';
    element: string;
    /** Card content: 'simple' shows no rows; 'shaped' shows property-shape rows only. Absent: detailed. */
    display?: CardDisplay;
}


/** A named, colored rectangle in a view. Layout only: it has no meaning in the model. */
export interface ViewGroup extends BoxBase {
    kind: 'group';
    label: string;
}


/** Free-positioned text that belongs to one view, not to the model. */
export interface ViewNote extends BoxBase {
    kind: 'note';
    text: string;
}


/** A positioned link from one view to another. Multiple links to the same target are allowed. */
/** A link box: to a view (`target`), or to a file (`file`). */
export interface ViewReference extends BoxBase {
    kind: 'reference';
    target?: string;      // target view id
    /** File reference: the path relative to the view file (view:file); `path`: absolute; `broken`: the file is not on disk. */
    file?: string;
    path?: string;
    broken?: boolean;
}


/**
 * Cards of one view shown as one box with a list, as a Reactodia entity group. The members keep their cards (they are in the view,
 * their relations show), but the view editor draws the collection instead of their cards, and bundles their edges.
 */
export interface ViewCollection extends BoxBase {
    kind: 'collection';
    members: string[];    // instance ids
}


export type ViewBox = ViewCard | ViewGroup | ViewNote | ViewReference | ViewCollection;

export type BoxKind = ViewBox['kind'];


/** The boxes of one kind in a view, in view order. */
export function boxes<K extends BoxKind>(view: View | undefined, kind: K): Extract<ViewBox, { kind: K }>[] {
    return view?.boxes.filter((b): b is Extract<ViewBox, { kind: K }> => b.kind === kind) ?? [];
}


/** The box with this id in a view: the id of its placement. */
export function boxOf(view: View | undefined, id: string): ViewBox | undefined {
    return view?.boxes.find(b => b.id === id);
}


/** The card of an element (by element id) in a view. */
export function cardOf(view: View | undefined, elementId: string): ViewCard | undefined {
    return view?.boxes.find((b): b is ViewCard => b.kind === 'card' && b.element === elementId);
}


/** The id of the placement that shows an element in a view (its card or placed edge); other ids stay. */
export function placementOfId(view: View | undefined, id: string): string {
    return cardOf(view, id)?.id ?? view?.edges.find(e => e.relation === id && e.id)?.id ?? id;
}


/**
 * The element that a placement of `view` places: a card its element, a placed edge its relation. Other ids stay: an element id,
 * and the placement of a mark, a view reference or an arrow (the read model identifies these by their placement).
 */
export function elementOfId(view: View | undefined, id: string): string {
    const b = boxOf(view, id);
    if (b?.kind === 'card') return b.element;
    return view?.edges.find(e => e.id === id)?.relation ?? id;
}


/**
 * An arrow from one box of a view to another (card, group, note, view reference, collection), with a note at one end at least.
 * Informative only: it belongs to the view graph, not to the model. `from`, `to`: box ids (a card: the id of its placement).
 */
export interface ViewArrow {
    id: string;
    from: string;
    to: string;
    color?: string;
}


/** Layout or visibility of one relation in one view. Present only when it has data. */
export interface EdgeLayout {
    /** Id of the placement of the relation; absent when the view does not place it (hidden). */
    id?: string;
    relation: string;    // relation id
    fromSide?: Side;
    toSide?: Side;
    /** Bends of the edge, in canvas coordinates, from the source to the target. Absent: none. */
    vertices?: { x: number; y: number }[];
    color?: string;
    hidden?: boolean;
}


/** The `view:vertices` literal of a placement: "x,y x,y …", integers. An unreadable pair ends the list. */
export function parseVertices(text: string | undefined): { x: number; y: number }[] | undefined {
    const out: { x: number; y: number }[] = [];
    for (const pair of (text ?? '').trim().split(/\s+/).filter(Boolean)) {
        const [x, y] = pair.split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) break;
        out.push({ x, y });
    }
    return out.length ? out : undefined;
}


export interface View {
    id: string;
    label: string;
    uri: string;         // graph IRI
    /** Free-text Markdown explanation, stored in the view graph. */
    description?: string;
    /** Cards, groups, notes, view references and collections. */
    boxes: ViewBox[];
    edges: EdgeLayout[];
    arrows: ViewArrow[];
}


export interface Doc {
    conformsTo?: string;
    instances: Record<string, Instance>;
    relations: Record<string, Relation>;
    views: Record<string, View>;
    /** Node shapes, property shapes and logical constraints of the shapes files (empty in the part of a view without shape elements). */
    shapes: ShapesModel;
}


export function emptyDoc(): Doc {
    return { instances: {}, relations: {}, views: {}, shapes: emptyShapes() };
}


/** Order by label. */
export const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);


/** The view shows the instance: its card, or a member row of an entity group (a member has no placement). */
export const inView = (view: View | undefined, instanceId: string) => !!cardOf(view, instanceId) || boxes(view, 'collection').some(c => c.members.includes(instanceId));


/** Both ends of the relation are in the view: the view shows the edge, or hides it. */
const hasEnds = (view: View | undefined, r: Relation | undefined) => !!r && inView(view, r.subject) && inView(view, r.object);


/** The box of `view` that shows an instance: its card, or the card of a value set that lists it. */
export function boxShowing(doc: Doc, view: View | undefined, instanceId: string): string | undefined {
    if (!view) return undefined;
    const card = cardOf(view, instanceId);
    if (card) return card.id;
    const uri = doc.instances[instanceId]?.uri;
    if (!uri) return undefined;
    const set = Object.values(doc.shapes.valueSets).find(s => inView(view, s.id) && s.members.some(m => m.uri === uri));
    return set && cardOf(view, set.id)?.id;
}


export function hiddenNeighbors(doc: Doc, view: View | undefined, id: string, dir: 'in' | 'out'): { instance: Instance; relations: Relation[] }[] {
    const found = new Map<string, Relation[]>();
    for (const r of Object.values(doc.relations)) {
        const [self, other] = dir === 'out' ? [r.subject, r.object] : [r.object, r.subject];
        if (self !== id || other === id || !doc.instances[other]) continue;
        if (boxShowing(doc, view, other) !== undefined && view && view.edges.some(e => e.relation === r.id && !e.hidden)) continue;
        found.set(other, [...(found.get(other) ?? []), r]);
    }
    return [...found].map(([other, relations]) => ({ instance: doc.instances[other], relations })).sort((a, b) => byLabel(a.instance, b.instance));
}


/** Relations shown (or hidden) in a view: all relations whose two ends are in the view. */
export function relationsInView(doc: Doc, view: View): Relation[] {
    return Object.values(doc.relations).filter(r => hasEnds(view, r));
}


export function edgeLayout(view: View, relationId: string): EdgeLayout | undefined {
    return view.edges.find(e => e.relation === relationId);
}


export const MIN_GROUP = { width: 160, height: 100 };


/** Box r lies fully inside box g. */
export const inside = (r: Box, g: Box) => r.x >= g.x && r.y >= g.y && r.x + r.width <= g.x + g.width && r.y + r.height <= g.y + g.height;


export function formatVertices(points: readonly { x: number; y: number }[] | undefined): string | undefined {
    return points?.length ? points.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ') : undefined;
}

/** The collection that holds an instance in a view, if any. */
export function collectionOf(view: View, instanceId: string): ViewCollection | undefined {
    return boxes(view, 'collection').find(c => c.members.includes(instanceId));
}

/**
 * The group that holds a box (card, note, view reference or group) with the id `id`: the smallest group that contains it.
 * Equal boxes: the group with the lower id holds the other (no cycles). Apply Layout and the Outline use this rule.
 */
export function groupOf(view: View, box: Box, id: string): ViewGroup | undefined {
    return groupAmong(boxes(view, 'group'), box, id);
}

/** groupOf on a list of groups (in view order): the Outline query of the backend gives the groups without a View. */
function groupAmong<G extends Box & { id: string }>(groups: G[], box: Box, id: string): G | undefined {
    const area = (b: Box) => b.width * b.height;
    return groups
        .filter(g => g.id !== id && inside(box, g) && (area(g) > area(box) || g.id < id))
        .sort((a, b) => area(a) - area(b))[0];
}
