// View command types, clipboard layouts and placement helpers; adapted from Catenary packages/model/src/commands.ts.
import { CardDisplay, EdgeLayout, View, ViewBox, placementOfId } from './doc';

export type Rect = { x: number; y: number; width: number; height: number };

export type Point = { x: number; y: number };

/** View commands. Each command is one undo step. */
export type ViewCommand =
    /** Cards added around `at`. They bring the lines, links and hubs between them and the shown figures. */
    | { kind: 'addToView'; view: string; ids: string[]; at: Point }
    /** Relations dropped on a view: their ends not in the view are added around `at`, hidden edges show again. */
    | { kind: 'showRelations'; view: string; ids: string[]; at: Point }
    /** Draw a property shape or constraint as a line or hub, with its ends near `at`. */
    | { kind: 'showAsEdge'; view: string; id: string; at: Point }
    /** Remove placements and their dependent lines; delete view-owned elements, not model elements. */
    | { kind: 'removeFromView'; view: string; ids: string[] }
    /** Move or resize cards and view-owned nodes. A moved group takes the elements inside it. */
    | { kind: 'setBounds'; view: string; bounds: ({ id: string } & Partial<Rect>)[] }
    /** Apply Layout: new boxes, then clear the sides and bends of every edge placement of the view. */
    | { kind: 'setLayout'; view: string; bounds: ({ id: string } & Partial<Rect>)[] }
    | { kind: 'setEdgeLayout'; view: string; relation: string; patch: Partial<Omit<EdgeLayout, 'relation'>> }
    | { kind: 'hideEdges'; view: string; ids: string[]; hidden: boolean }
    /** Change view elements. `expectedText` rejects a note edit if another client changed its text. */
    | { kind: 'setViewElements'; view: string; ids: string[]; patch: ViewElementPatch; expectedText?: string }
    | { kind: 'createGroup'; view: string; label: string; around?: string[]; rect?: Rect }
    | { kind: 'createNote'; view: string; text: string; at: Point }
    | { kind: 'addViewReference'; view: string; target: string; at: Point }
    /** A link box to a file, relative to the view file. */
    | { kind: 'addFileReference'; view: string; file: string; at: Point }
    /** Arrow between two boxes of a view. One end must be a note. Removal: removeFromView. */
    | { kind: 'createArrow'; view: string; from: string; to: string }
    /** Collect cards into a new collection centered on their box. Selected collections join with their members. */
    | { kind: 'collect'; view: string; ids: string[] }
    /** Instances join a collection; an instance outside the view is added to it. */
    | { kind: 'addToCollection'; view: string; id: string; ids: string[] }
    /** Take members (all without `ids`) out of a collection. Delete an empty collection. */
    | { kind: 'uncollect'; view: string; id: string; ids?: string[] }
    /** Place the clip's existing elements near `at`, else its top-left corner. Groups and notes are new boxes. */
    | { kind: 'pasteIntoView'; view: string; clip: ViewClip; at?: Point; cardScale?: number }
    /** Move a cut clip between views in one undo step. Equal `from` and `to`: a re-placement. */
    | { kind: 'moveBetweenViews'; from: string; to: string; clip: ViewClip; at?: Point; cardScale?: number };

/** Changes of one element of a view. '' removes the color; display 'detailed' removes the display value. */
export type ViewElementPatch = Partial<Rect> & { color?: string; display?: CardDisplay; label?: string; text?: string };

/**
 * Layout copied from a view (Ctrl+C / Ctrl+X). Instances are referred to by IRI, not by session id, so that a clip
 * from another model can only refer to the same resources. A paste places the elements with these IRIs; it never creates
 * instances. Mode 'cut': the paste moves them from view `source` (moveBetweenViews).
 */
export interface ViewClip {
    format: typeof VIEW_CLIP_FORMAT;
    mode: ClipMode;
    /** IRI of the source view. */
    source: string;
    /**
     * Cards, groups, notes and view references. `id` and `element` of a card: the IRI of its element; `target` of a view reference: the view IRI,
     * so a clip does not depend on session ids. Other boxes: the id in the source view (not used by a paste).
     */
    boxes: Exclude<ViewBox, { kind: 'collection' }>[];
    edges: (Omit<EdgeLayout, 'relation'> & { subject: string; predicate: string; object: string })[];
}

export const VIEW_CLIP_FORMAT = 'application/x-catenary-view-clip';

export type ClipMode = 'copy' | 'cut';

import { DEFAULT_SIZE, Doc, boxes, cardOf, inside } from './doc';

/** Top-left corner of a default-size card centered on `at`. */
export function centered(at: Point): Point {
    return { x: at.x - DEFAULT_SIZE.width / 2, y: at.y - DEFAULT_SIZE.height / 2 };
}


const GAP = 60;

/** Top-left positions for `count` cards in a grid centered on `at`. */
export function gridPositions(count: number, at: Point): Point[] {
    const { width, height } = DEFAULT_SIZE;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const x0 = at.x - (cols * (width + GAP) - GAP) / 2, y0 = at.y - (rows * (height + GAP) - GAP) / 2;
    return Array.from({ length: count }, (_, i) => ({ x: x0 + (i % cols) * (width + GAP), y: y0 + Math.floor(i / cols) * (height + GAP) }));
}


/**
 * The elements that a selection takes: a group takes the elements fully inside it; a collection takes its members' cards.
 */
function selection(view: View, ids: string[]): ViewBox[] {
    // `ids`: box ids (placements); a card also by the id of its element.
    const picked = boxes(view, 'group').filter(x => ids.includes(x.id));
    const taken = (b: ViewBox) => ids.includes(b.id) || (b.kind === 'card' && ids.includes(b.element)) || picked.some(x => x.id !== b.id && inside(b, x));
    const collections = boxes(view, 'collection').filter(taken);
    return view.boxes.filter(b => taken(b) || (b.kind === 'card' && collections.some(c => c.members.includes(b.element))));
}

/** Clip of the selected cards and groups of a view. Edge layouts come with the relations between the clipped cards. */
export function copyFromView(doc: Doc, viewId: string, ids: string[], mode: ClipMode = 'copy'): ViewClip | undefined {
    const view = doc.views[viewId];
    if (!view) return undefined;
    const uri = (id: string) => doc.instances[id]?.uri ?? doc.shapes.nodeShapes[id].uri;
    const sel = selection(view, ids);
    const clipped = sel.flatMap((b): ViewClip['boxes'] => {
        if (b.kind === 'card') return [{ ...b, id: uri(b.element), element: uri(b.element) }];
        // A file reference is not copied (its path is relative to its view file).
        if (b.kind === 'reference') return b.target && doc.views[b.target] ? [{ ...b, target: doc.views[b.target].uri }] : [];
        // An entity group gives its members as cards (a member has no placement), stacked from the corner of the group.
        if (b.kind === 'collection') return b.members.filter(m => doc.instances[m] && !cardOf(view, m)).map((m, i) => ({
            kind: 'card' as const, id: uri(m), element: uri(m), x: b.x + i * 40, y: b.y + i * 40, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height
        }));
        return [b];
    });
    if (clipped.length === 0) return undefined;
    const members = new Set(sel.flatMap(b => b.kind === 'card' ? [b.element] : b.kind === 'collection' ? b.members : []));
    const edges = view.edges.flatMap(({ relation, id: _placement, ...layout }) => {
        const r = doc.relations[relation];
        return r && members.has(r.subject) && members.has(r.object) ? [{ subject: uri(r.subject), predicate: r.predicate, object: uri(r.object), ...layout }] : [];
    });
    return { format: VIEW_CLIP_FORMAT, mode, source: view.uri, boxes: clipped, edges };
}

export function isViewClip(x: unknown): x is ViewClip {
    const c = x as ViewClip;
    return !!c && c.format === VIEW_CLIP_FORMAT && (c.mode === 'copy' || c.mode === 'cut') && typeof c.source === 'string' && Array.isArray(c.boxes) && Array.isArray(c.edges);
}


/** Why an arrow from `from` to `to` (element or box ids) cannot be drawn in `view`; undefined: it can. */
export function arrowProblem(view: View, from: string, to: string): string | undefined {
    const [a, b] = [from, to].map(id => placementOfId(view, id));   // ViewArrow ends are box ids
    if (a === b) return 'An arrow connects two different elements.';
    const isNote = (id: string) => view.boxes.some(x => x.id === id && x.kind === 'note');
    if (!isNote(a) && !isNote(b)) return 'An arrow starts or ends at a note.';
    if (view.arrows.some(x => x.from === a && x.to === b)) return 'This arrow exists already.';
    return undefined;
}

/** Label for a new element: "unnamed <kind> 1", "unnamed <kind> 2", ... The first one that no element in `taken` has. */
export function unnamedLabel(kind: string, taken: Iterable<{ label: string }>): string {
    const used = new Set([...taken].map(t => t.label));
    const base = `unnamed ${kind.toLowerCase()}`;
    for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}
