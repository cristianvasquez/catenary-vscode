// View placement and mark edits over graph quads; adapted from Catenary packages/rdf/src/ops.ts.
import type { NamedNode, Quad, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import { centered, gridPositions, ViewElementPatch } from '../model/commands';
import { Box, DEFAULT_COLLECTION_SIZE, DEFAULT_NOTE_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE, EdgeLayout, formatVertices, GROUP_SIZE, inside, MIN_GROUP, parseVertices } from '../model/doc';
import { nkey } from '../model/notation-graph';
import { alternativesOf, rangeText } from '../model/shapes-doc';
import { pills, pillSize, targetSize } from '../model/shapes-schema';
import { NS, TermJSON } from '../model/terms';
import { ModelGraph } from './graph';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import { viewFiguresOf } from './notations';
import { shapesCardTerm, shapesIndexOf as shapesIndex } from './shapes-read';
import { rdf } from './terms';
import { connectorOf, connectorPlacements, edgeOf, isView, markIri, nodeOf, placementIri, V, views, viewSubject } from './views';
import { homeOf, isInstance, label, ownedBy, P } from './vocabulary';

export type Result<T = void> = { ok: true; value: T; changed?: false; message?: string } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = (error: string): Result<never> => ({ ok: false, error });

/** A command that has nothing to change: ok, no patch, no undo step, no write. It has no value. */
export const noop = (message: string): Result<never> => ({ ok: true, value: undefined as never, changed: false, message });

/** An id that names no element of this kind: the caller gave a wrong id, or the element was deleted. */
export const gone = (what: string, id: string): Result<never> => fail(`No ${what} with the id ${id}: the id is wrong or the ${what} was deleted.`);

const integer = (n: number) => rdf.literal(String(Math.round(n) || 0), rdf.namedNode(NS.xsd + 'integer'));

// ------------------------------------------------------------------ resolve ids

export function instanceTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return isInstance(g, t) ? t : undefined;
}

/** A node shape, value set or property shape with an IRI: drawn as a shape element. */
function shapeCardTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && g.match(t).some(q => g.isShapesQuad(q)) ? shapesCardTerm(g, id) : undefined;
}

/** The element of a card in a view: a shape element, else an instance, else a class pill, else a list figure. A shape wins when the same IRI is both. */
export function cardTerm(g: ModelGraph, id: string): NamedNode | undefined {
    return shapeCardTerm(g, id) ?? instanceTerm(g, id) ?? pillTerm(g, id) ?? listTerm(id);
}

/** The term of a list figure ("in", "one of", hub): `urn:trellis:list:<hash>`. It has no statements. */
export const LIST_PREFIX = 'urn:trellis:list:';

function listTerm(id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && t.value.startsWith(LIST_PREFIX) ? t : undefined;
}

/** The IRI of a pill (`pills`): a datatype, node kind or class without a node shape that is the range of a property shape. */
function pillTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const pill = pills(shapesIndex(g).model).get(id);
    return pill && rdf.namedNode(pill.iri);
}

export function viewTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && isView(g, t) ? t : undefined;
}

/** Types of marks: elements kept by their placements. */
const MARK_TYPES = [V.Frame, V.Note, V.FileRef, V.EntityGroup, V.Pill];

/** View-owned elements, by kind: the placement of a mark (its type), of a view (`V.View`: a view reference), of an arrow (`V.arrow`). */
const VIEW_ELEMENT_TYPES = [...MARK_TYPES, V.View, V.arrow];

/** The element of a placement in a view. */
function elementOf(g: ModelGraph, view: NamedNode, placement: Term): NamedNode | undefined {
    const e = g.objects(placement, V.element, view)[0];
    return e?.termType === 'NamedNode' ? e : undefined;
}

/**
 * The element id that an id stands for (a placement is not its element): the placement of a card gives
 * its element, the placement of a relation gives the relation. Other ids stay: an element id, and the placement of a mark, a view
 * or an arrow (the read model identifies these by their placement).
 */
export function elementIdOf(g: ModelGraph, id: string): string {
    const t = elementTerm(id);
    const view = t && g.match(t, P.type, V.Placement).find(q => isView(g, q.graph))?.graph;
    if (!t || !view) return id;
    const e = elementOf(g, view as NamedNode, t);
    if (e) return markType(g, e) || isView(g, e) ? id : elementId(e);
    const c = connectorOf(g, t, view);
    return c && !c.predicate.equals(V.arrow) ? relationId(c.subject as NamedNode, c.predicate as NamedNode, c.object as NamedNode) : id;
}

/** The type of a mark (MARK_TYPES), or undefined. */
function markType(g: ModelGraph, e: Term): NamedNode | undefined {
    return MARK_TYPES.find(t => g.match(e as NamedNode, P.type, t).length > 0);
}

/** Kind of a placement: the type of its mark, `V.View` for a placement of a view, `V.arrow` for an arrow, undefined for a card or relation. */
function placementKind(g: ModelGraph, view: NamedNode, placement: Term): NamedNode | undefined {
    const e = elementOf(g, view, placement);
    if (!e) return connectorOf(g, placement, view)?.predicate.equals(V.arrow) ? V.arrow : undefined;
    return isView(g, e) ? V.View : markType(g, e);
}

/** The graph that holds the statements of a mark (its type statement). */
function markGraph(g: ModelGraph, mark: NamedNode): NamedNode {
    return g.match(mark, P.type).find(q => MARK_TYPES.some(t => t.equals(q.object)))!.graph as NamedNode;
}

/** A view-owned element of one of `types` in a view graph: a placement whose kind is in `types`, or an arrow. */
export function viewElementTerm(g: ModelGraph, view: NamedNode, id: string, types = VIEW_ELEMENT_TYPES): NamedNode | undefined {
    const t = elementTerm(id);
    if (t?.termType !== 'NamedNode') return undefined;
    if (!g.has(rdf.quad(t, P.type, V.Placement, view))) return undefined;
    const kind = placementKind(g, view, t);
    return kind && types.some(x => x.equals(kind)) ? t : undefined;
}

/** A new mark of `type` in a view graph, with its content statements. */
export function newMark(g: ModelGraph, view: NamedNode, type: NamedNode, content: [NamedNode, Quad_Object][]): NamedNode {
    const m = markIri(g, view);
    g.add(m, P.type, type, view);
    for (const [p, o] of content) g.add(m, p, o, view);
    return m;
}

/** A new placement of an element in a view, with a box. */
function newPlacement(g: ModelGraph, view: NamedNode, element: NamedNode, box: Partial<Box>, color?: string): NamedNode {
    const p = addPlacement(g, view, element);
    writeBox(g, view, p, box);
    if (color) writeString(g, view, p, V.color, color);
    return p;
}

/** Remove a placement. A mark or an arrow without placements is deleted. */
function removePlacement(g: ModelGraph, view: NamedNode, placement: Quad_Subject): void {
    const e = elementOf(g, view, placement);
    const t = connectorOf(g, placement, view);
    const arrow = t?.predicate.equals(V.arrow) ? [t.subject, t.object] : undefined;
    g.removeMatches(placement, null, null, view);
    if (e && markType(g, e) && g.match(null, V.element, e).length === 0) g.removeMatches(e, null, null, markGraph(g, e));
    if (arrow?.[0] && arrow[1] && !arrowPlacements(g, arrow[0], arrow[1]).length) g.removeMatches(arrow[0], V.arrow, arrow[1]);
}

/** The placements of the arrow `s view:arrow o`, in all views. */
function arrowPlacements(g: ModelGraph, s: Term, o: Term): Quad[] {
    return g.match(null, P.reifies, rdf.quad(s as Quad_Subject, V.arrow, o as Quad_Object)).filter(q => g.has(rdf.quad(q.subject, P.type, V.Placement, q.graph)));
}

export function relationTerms(g: ModelGraph, id: string): { s: NamedNode; p: NamedNode; o: NamedNode } | undefined {
    const r = relationTriple(id);
    return r && isInstance(g, r.s) && isInstance(g, r.o) && g.has(rdf.quad(r.s, r.p, r.o, homeOf(g, r.s))) ? r : undefined;
}

/**
 * A new placement of `placed` in a view (graph.ts `placementIri`): its type, its view and what it places, `view:element` for an
 * element and `rdf:reifies` for a triple (a connector).
 */
export function addPlacement(g: ModelGraph, view: NamedNode, placed: NamedNode | Quad): NamedNode {
    const p = placementIri(view.value, placed);
    g.add(p, P.type, V.Placement, view);
    g.add(p, V.view, view, view);
    if (placed.termType === 'Quad') g.add(p, P.reifies, placed, view); else g.add(p, V.element, placed, view);
    return p;
}

/** Remove the quads of a subject in a graph, and of the objects that it owns (`ownedBy`, vocabulary.ts). */
export function removeTree(g: ModelGraph, s: Term, graph: Term): void {
    const owned = g.match(s, null, null, graph).map(q => q.object).filter(o => ownedBy(g, o, s, graph));
    g.removeMatches(s, null, null, graph);
    for (const o of owned) removeTree(g, o, graph);
}

/** Remove the node of an instance (or node shape), its edge layouts and its collection membership from one view graph. */
export function dropFromView(g: ModelGraph, view: NamedNode, s: NamedNode): void {
    const node = nodeOf(g, view, s);
    if (node) removePlacement(g, view, node);
    g.removeMatches(null, V.member, s, view);
    for (const c of connectorPlacements(g, view)) if (c.triple.subject.equals(s) || c.triple.object.equals(s)) removeTree(g, c.placement, view);
}

// ------------------------------------------------------------------ view membership and layout

function readBox(g: ModelGraph, view: Term, s: Term, fallback = DEFAULT_SIZE): Box {
    return {
        x: g.number(s, V.x, view, 0), y: g.number(s, V.y, view, 0),
        width: g.number(s, V.width, view, fallback.width), height: g.number(s, V.height, view, fallback.height)
    };
}

export function writeBox(g: ModelGraph, view: NamedNode, s: Quad_Subject, box: Partial<Box>): void {
    for (const k of ['x', 'y', 'width', 'height'] as const) {
        const v = box[k];
        if (typeof v === 'number' && isFinite(v)) g.set(s, V[k], integer(v), view);
    }
}

function writeString(g: ModelGraph, view: NamedNode, s: Quad_Subject, p: NamedNode, v: string | undefined): void {
    g.set(s, p, v ? rdf.literal(v) : undefined, view);
}

/** Size of a new node shape card (name and target class); the card grows with its rows. */
const SHAPE_CARD_SIZE = { width: 520, height: 120 };

/** Size of a value set node (concepts as chips) and of the target node of a property drawn out of its card. */
const VALUE_SET_SIZE = { width: 320, height: 160 };

function shapesCardSize(g: ModelGraph, id: string): { width: number; height: number } {
    const idx = shapesIndex(g);
    const property = idx.model.properties[id];
    return idx.valueSet.has(id) ? VALUE_SET_SIZE : property ? targetSize(idx.model, property, alternativesOf(property.range).length) : SHAPE_CARD_SIZE;
}

/** Size of a new card: a shape element or a value set (also a scheme or collection in a data file) as `shapesCardSize`, else DEFAULT_SIZE. */
export function cardSize(g: ModelGraph, id: string): { width: number; height: number } {
    if (shapeCardTerm(g, id) || shapesIndex(g).valueSet.has(id)) return shapesCardSize(g, id);
    const model = shapesIndex(g).model, pill = !instanceTerm(g, id) && pills(model).get(id);
    return pill ? pillSize(rangeText(model, pill.range)) : DEFAULT_SIZE;
}

export function addToView(g: ModelGraph, viewId: string, instanceId: string, at: { x: number; y: number }, size?: { width: number; height: number }): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    size ??= cardSize(g, instanceId);
    const s = cardTerm(g, instanceId);
    if (!s) return fail('A view shows instances, node shapes, concept schemes, collections, properties with an IRI and pills.');
    if (nodeOf(g, view, s)) return fail(`"${label(g, s)}" is already in view "${label(g, viewSubject(g, view)!, view)}".`);
    const node = addPlacement(g, view, s);
    writeBox(g, view, node, { ...at, ...size });
    return ok(undefined);
}

/** The placement of a connector (a relation, an arrow) in a view; a new one if there is none. */
function placeConnector(g: ModelGraph, view: NamedNode, s: NamedNode, p: NamedNode, o: NamedNode): Quad_Subject {
    const found = edgeOf(g, view, s, p, o);
    if (found) return found;
    const e = addPlacement(g, view, rdf.quad(s, p, o));
    return e;
}

/** The line placement of a property shape in a view: the property drawn as an edge. */
function lineOf(g: ModelGraph, view: NamedNode, propertyId: string): Quad_Subject | undefined {
    const p = shapesIndex(g).model.properties[propertyId];
    return p?.uri ? nodeOf(g, view, rdf.namedNode(p.uri)) : undefined;
}

/**
 * Sides, vertices or color of an edge in one view ('' / undefined / [] remove the value): a relation, or a property shape drawn as an
 * edge (its line placement must exist). `hidden`: true removes the placement of the relation, false places it; no hidden state is stored. A property shape takes no `hidden`.
 */
export function setEdgeLayout(g: ModelGraph, viewId: string, relationId: string, patch: Partial<Omit<EdgeLayout, 'relation'>>): Result {
    const view = viewTerm(g, viewId), r = relationTerms(g, relationId);
    if (!view) return gone('view', viewId);
    let e: Quad_Subject;
    if (r) {
        if (patch.hidden) {
            const placed = edgeOf(g, view, r.s, r.p, r.o);
            if (placed) removeTree(g, placed, view);
            return ok(undefined);
        }
        e = placeConnector(g, view, r.s, r.p, r.o);
    } else {
        const line = lineOf(g, view, relationId);
        if (!line) return gone('relation', relationId);
        if (patch.hidden) return fail('A property edge cannot be hidden. Show it as a row.');
        e = line;
    }
    for (const k of ['fromSide', 'toSide', 'color'] as const) if (k in patch) writeString(g, view, e, V[k], patch[k]);
    if ('vertices' in patch) writeString(g, view, e, V.vertices, formatVertices(patch.vertices));
    return ok(undefined);
}

/**
 * The bends of each edge placement of a view whose both ends move by one delta, moved by that delta. A connector
 * (rdf:reifies): its ends are the placements of the statement ends. A property line (view:element): its ends are the placements of
 * its start and end figures (the join of the view); a shared property shape has one line for each shown owner, and its one placement
 * moves once, only when every start and the end move by one delta.
 */
function moveVertices(g: ModelGraph, view: NamedNode, delta: Map<string, { dx: number; dy: number }>): void {
    if (![...delta.values()].some(d => d.dx || d.dy)) return;
    const move = (e: Quad_Subject, da: { dx: number; dy: number } | undefined, db: { dx: number; dy: number } | undefined) => {
        if (!da || !db || da.dx !== db.dx || da.dy !== db.dy || (!da.dx && !da.dy)) return;
        const points = parseVertices(g.objects(e, V.vertices, view)[0]?.value);
        if (points) writeString(g, view, e, V.vertices, formatVertices(points.map(p => ({ x: p.x + da.dx, y: p.y + da.dy }))));
    };
    const lines: Quad_Subject[] = [];
    for (const e of g.subjects(V.vertices, null, view)) {
        const t = connectorOf(g, e, view);
        if (!t) { lines.push(e); continue; }
        const a = nodeOf(g, view, t.subject), b = nodeOf(g, view, t.object);
        move(e, a && delta.get(a.value), b && delta.get(b.value));
    }
    if (lines.length === 0) return;
    const vf = viewFiguresOf(g, view.value);
    const placementOf = (f: { placedAs: TermJSON } | undefined) => f && vf.placed.get(nkey(f.placedAs))?.iri;
    // The deltas of the ends of each line placement: all must be equal for the bends to move.
    const ends = new Map<string, ({ dx: number; dy: number } | undefined)[]>();
    for (const l of vf.join.lines) {
        const own = placementOf(l.figure);
        if (!own || !lines.some(x => x.value === own)) continue;
        const da = delta.get(placementOf(l.start) ?? '');
        const list = ends.get(own) ?? ends.set(own, []).get(own)!;
        list.push(da, delta.get(placementOf(l.end) ?? ''));
    }
    for (const e of lines) {
        const list = ends.get(e.value);
        if (!list?.length) continue;
        const same = (a: { dx: number; dy: number } | undefined, b: { dx: number; dy: number } | undefined) => !!a && !!b && a.dx === b.dx && a.dy === b.dy;
        move(e, list[0], list.every(d => same(d, list[0])) ? list[0] : undefined);
    }
}

/** Apply Layout: the sides and bends of every edge placement of the view go. */
export function clearEdgeLayouts(g: ModelGraph, viewId: string): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    for (const p of [V.fromSide, V.toSide, V.vertices]) for (const e of g.subjects(p, null, view)) g.set(e, p, undefined, view);
    return ok(undefined);
}

export function hideEdge(g: ModelGraph, viewId: string, relationId: string, hidden: boolean): Result {
    return setEdgeLayout(g, viewId, relationId, { hidden });
}

const isInstanceTerm = (g: ModelGraph, t: Term): t is NamedNode =>
    t.termType === 'NamedNode' && (g.match(t as NamedNode, P.type, null, g.union).length > 0 || g.match(t as NamedNode, P.label, null, g.union).length > 0);

/** A statement of the model graph that the read model shows as a relation: both ends are instances, not rdf:type or rdfs:label. */
function isRelation(g: ModelGraph, q: Quad): boolean {
    return g.isDataQuad(q) && !q.predicate.equals(P.type) && !q.predicate.equals(P.label)
        && isInstanceTerm(g, q.subject) && isInstanceTerm(g, q.object) && g.has(q);
}

/** A connector: a relation of the model graph, or an arrow (`x view:arrow y`, in a view graph). */
function isConnector(g: ModelGraph, q: Quad): boolean {
    return q.predicate.equals(V.arrow) ? g.has(q) && q.object.termType === 'NamedNode' : isRelation(g, q);
}

/**
 * Runs after each command. A new placement of an element places its connectors (relations, arrows) to the
 * elements already placed in that view. A new connector is placed in every view that places both ends.
 */
export function placeConnectors(g: ModelGraph): void {
    const placed: { view: NamedNode; s: NamedNode }[] = [];
    const relations: Quad[] = [];
    for (const c of g.changes()) {
        if (c.op !== 'add') continue;
        const q = c.quad;
        if (q.predicate.equals(V.element) && q.object.termType === 'NamedNode' && q.graph.termType === 'NamedNode') placed.push({ view: q.graph, s: q.object });
        else if (g.isDataQuad(q) || q.predicate.equals(V.arrow)) relations.push(q);
    }
    for (const { view, s } of placed) {
        if (!nodeOf(g, view, s)) continue;
        const touching = [...g.match(s, null, null, g.union), ...g.match(null, null, s, g.union), ...g.match(s, V.arrow), ...g.match(null, V.arrow, s)];
        for (const q of touching) {
            const other = q.subject.equals(s) ? q.object : q.subject;
            if (other.termType === 'NamedNode' && nodeOf(g, view, other) && isConnector(g, q)) placeConnector(g, view, q.subject as NamedNode, q.predicate as NamedNode, q.object as NamedNode);
        }
    }
    for (const q of relations) {
        if (!isConnector(g, q)) continue;
        for (const view of views(g)) {
            if (nodeOf(g, view, q.subject) && nodeOf(g, view, q.object)) placeConnector(g, view, q.subject as NamedNode, q.predicate as NamedNode, q.object as NamedNode);
        }
    }
}

// ------------------------------------------------------------------ groups (layout only)

export function createGroup(g: ModelGraph, viewId: string, label: string, rect: Box, color?: string): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    if (!label.trim()) return fail('The group name is empty.');
    const frame = newMark(g, view, V.Frame, [[P.label, rdf.literal(label.trim())]]);
    const b = newPlacement(g, view, frame, { x: rect.x, y: rect.y, width: Math.max(MIN_GROUP.width, rect.width), height: Math.max(MIN_GROUP.height, rect.height) }, color);
    return ok(elementId(b));
}

// ------------------------------------------------------------------ notes and view references (view only)

export function createNote(g: ModelGraph, viewId: string, text: string, at: { x: number; y: number }): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    const note = newMark(g, view, V.Note, [[V.text, rdf.literal(text)]]);
    return ok(elementId(newPlacement(g, view, note, { ...at, ...DEFAULT_NOTE_SIZE })));
}

export function createViewReference(g: ModelGraph, viewId: string, targetId: string, at: { x: number; y: number }): Result<string> {
    const view = viewTerm(g, viewId), target = viewTerm(g, targetId);
    if (!view) return gone('view', viewId);
    if (!target) return gone('view', targetId);
    // A view reference is a placement of the view. A view places it once.
    if (nodeOf(g, view, target)) return fail(`View "${label(g, target, target)}" is already in view "${label(g, view, view)}".`);
    return ok(elementId(newPlacement(g, view, target, { ...at, ...DEFAULT_VIEW_REFERENCE_SIZE })));
}

/** A link box to a file: `file` is the path relative to the view file (ModelStore makes it relative). */
export function createFileReference(g: ModelGraph, viewId: string, file: string, at: { x: number; y: number }): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    if (!file.trim()) return fail('No file.');
    const ref = newMark(g, view, V.FileRef, [[V.file, rdf.literal(file)]]);
    return ok(elementId(newPlacement(g, view, ref, { ...at, ...DEFAULT_VIEW_REFERENCE_SIZE })));
}

// ------------------------------------------------------------------ any element of a view

/**
 * Change one element of a view: its box, its color, and the field of its kind: display of a card, label of a group, text of a
 * note. A field that the element does not have is ignored. A relation takes only the color (its edge layout).
 * `expectedText` (a note) protects a local editor draft from overwriting another client's change.
 */
export function setViewElement(g: ModelGraph, viewId: string, id: string, patch: ViewElementPatch, expectedText?: string): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    if (relationTerms(g, id)) return 'color' in patch ? setEdgeLayout(g, viewId, id, { color: patch.color }) : ok(undefined);
    const s = boxSubject(g, view, id) ?? viewElementTerm(g, view, id, [V.arrow]);
    if (!s) return fail('The element is not in this view any more.');
    const arrow = !!placementKind(g, view, s)?.equals(V.arrow);
    const kind = arrow ? undefined : placementKind(g, view, s);
    const mark = kind && !kind.equals(V.View) ? elementOf(g, view, s) : undefined;
    const is = (type: NamedNode) => !!kind && kind.equals(type);
    let box: Partial<Box> = patch;
    if (is(V.Frame)) {
        if (patch.label !== undefined) {
            if (!patch.label.trim()) return fail('The group name is empty.');
            g.set(mark!, P.label, rdf.literal(patch.label.trim()), markGraph(g, mark!));
        }
        box = {
            ...patch,
            width: patch.width === undefined ? undefined : Math.max(MIN_GROUP.width, patch.width),
            height: patch.height === undefined ? undefined : Math.max(MIN_GROUP.height, patch.height)
        };
    }
    if (is(V.Note)) {
        if (expectedText !== undefined && (g.match(mark!, V.text, null)[0]?.object.value ?? '') !== expectedText) {
            return fail('This note changed elsewhere. Copy your draft, then reopen it.');
        }
        if (patch.text !== undefined) g.set(mark!, V.text, rdf.literal(patch.text), markGraph(g, mark!));
    }
    const card = !arrow && !kind;
    if (card && 'display' in patch) writeString(g, view, s, V.display, patch.display === 'simple' ? 'simple' : undefined);
    if (!arrow) writeBox(g, view, s, box);
    if ('color' in patch) writeString(g, view, s, V.color, patch.color);
    return ok(undefined);
}

/**
 * Remove elements from a view. A card leaves the view (the model does not change), the edge of a relation hides, a collection
 * leaves with its members, and a view-owned element is deleted.
 */
export function removeViewElements(g: ModelGraph, viewId: string, ids: string[]): void {
    const view = viewTerm(g, viewId);
    if (!view) return;
    for (const id of ids) {
        const card = cardTerm(g, id);
        if (card) dropFromView(g, view, card);
        else if (relationTerms(g, id)) hideEdge(g, viewId, id, true);
        else {
            const s = viewElementTerm(g, view, id);
            if (!s) continue;
            const e = elementOf(g, view, s);
            if (e && placementKind(g, view, s)?.equals(V.EntityGroup)) for (const m of g.objects(e, V.member, markGraph(g, e))) dropFromView(g, view, m as NamedNode);
            removePlacement(g, view, s);
        }
    }
}

// ------------------------------------------------------------------ arrows (view only)

/**
 * Arrow from one box of a view to another; one end is a note. The arrow is the statement `x view:arrow y` between the elements of the
 * boxes (in the view graph); a placement of it in this view shows it. Returns the id of the placement.
 */
export function createArrow(g: ModelGraph, viewId: string, fromId: string, toId: string): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    const from = boxSubject(g, view, fromId), to = boxSubject(g, view, toId);
    if (!from || !to) return fail('An arrow connects two elements of the view.');
    if (from.equals(to)) return fail('An arrow connects two different elements.');
    const isNote = (b: Term) => !!placementKind(g, view, b)?.equals(V.Note);
    if (!isNote(from) && !isNote(to)) return fail('An arrow starts or ends at a note.');
    const x = elementOf(g, view, from)!, y = elementOf(g, view, to)!;
    if (edgeOf(g, view, x, V.arrow, y)) return fail('This arrow exists already.');
    if (g.match(x, V.arrow, y).length === 0) g.add(x, V.arrow, y, view);
    return ok(elementId(placeConnector(g, view, x, V.arrow, y) as NamedNode));
}

/** Remove the placements of arrows whose ends the view does not place any more (the arrow goes with its last placement). Runs after each command. */
export function pruneArrows(g: ModelGraph): void {
    for (const { placement, triple, view } of connectorPlacements(g)) {
        if (!triple.predicate.equals(V.arrow)) continue;
        const x = triple.subject, y = triple.object;
        if (!shownIn(g, view, x) || !shownIn(g, view, y) || g.match(x as NamedNode, V.arrow, y).length === 0) removePlacement(g, view, placement);
    }
}

/** The view shows the element: its placement, or the placement of an entity group that has it as a member. */
function shownIn(g: ModelGraph, view: NamedNode, x: Term): boolean {
    return !!nodeOf(g, view, x) || g.match(null, V.member, x).some(q => !!nodeOf(g, view, q.subject));
}

// ------------------------------------------------------------------ collections (view only)

/**
 * A member of an entity group has no placement of its own while it is in the group: its placement goes, and so do the
 * placements of its relations (the group draws them as bundles). An arrow keeps its placement: it ends at the group.
 */
function unplaceMember(g: ModelGraph, view: NamedNode, m: NamedNode): void {
    const node = nodeOf(g, view, m);
    if (node) removeTree(g, node, view);
    for (const c of connectorPlacements(g, view)) {
        if (!c.triple.predicate.equals(V.arrow) && (c.triple.subject.equals(m) || c.triple.object.equals(m))) removeTree(g, c.placement, view);
    }
}

/** New collection of instances of a view, at `rect`. The instances lose their placements; members of other collections leave them. */
export function createCollection(g: ModelGraph, viewId: string, instanceIds: string[], rect: Box): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    // In the view: a card, or a member of an entity group of the view (it has no placement).
    const members = instanceIds.map(id => instanceTerm(g, id)).filter((s): s is NamedNode => !!s && (!!nodeOf(g, view, s) || g.match(null, V.member, s, view).length > 0));
    if (members.length === 0) return fail('Select the cards to collect.');
    for (const m of members) for (const q of g.match(null, V.member, m, view)) g.remove(q);
    const group = newMark(g, view, V.EntityGroup, members.map(m => [V.member, m]));
    for (const m of members) unplaceMember(g, view, m);
    return ok(elementId(newPlacement(g, view, group, rect)));
}

/** Instances join a collection. A member has no placement of its own (C1). */
export function addToCollection(g: ModelGraph, viewId: string, id: string, instanceIds: string[]): Result {
    const view = viewTerm(g, viewId);
    const c = view && viewElementTerm(g, view, id, [V.EntityGroup]);
    if (!view || !c) return fail('No such collection.');
    const mark = elementOf(g, view, c)!, graph = markGraph(g, mark);
    const members = instanceIds.map(i => instanceTerm(g, i)).filter((s): s is NamedNode => !!s);
    if (members.length === 0) return fail('No such instance.');
    for (const m of members) {
        unplaceMember(g, view, m);
        g.removeMatches(null, V.member, m, view);
        g.add(mark, V.member, m, graph);
    }
    return ok(undefined);
}

/** Take members (all without `instanceIds`) out of a collection. Their cards go next to it, on the right. An empty collection is deleted. */
export function uncollect(g: ModelGraph, viewId: string, id: string, instanceIds?: string[]): Result<string[]> {
    const view = viewTerm(g, viewId);
    const c = view && viewElementTerm(g, view, id, [V.EntityGroup]);
    if (!view || !c) return fail('No such collection.');
    const mark = elementOf(g, view, c)!, graph = markGraph(g, mark);
    const members = g.objects(mark, V.member, graph).filter(m => !instanceIds || instanceIds.includes(elementId(m as NamedNode))) as NamedNode[];
    const box = readBox(g, view, c, DEFAULT_COLLECTION_SIZE);
    const at = { x: box.x + box.width + 60 + DEFAULT_SIZE.width / 2, y: box.y + box.height / 2 };
    const places = members.length === 1 ? [centered(at)] : gridPositions(members.length, { x: at.x + DEFAULT_SIZE.width / 2, y: at.y });
    // A released member gets its placement again (an older view file can still have one).
    members.forEach((m, i) => {
        g.remove(rdf.quad(mark, V.member, m, graph));
        writeBox(g, view, nodeOf(g, view, m) ?? addPlacement(g, view, m), { ...places[i], ...DEFAULT_SIZE });
    });
    if (g.objects(mark, V.member, graph).length === 0) removePlacement(g, view, c);
    return ok(members.map(m => elementId(m)));
}

const BOX_TYPES = [...MARK_TYPES, V.View];

/** The subject that holds the box of a card (by instance id), group, note, view reference or collection in a view. */
function boxSubject(g: ModelGraph, view: NamedNode, id: string): Quad_Subject | undefined {
    const s = cardTerm(g, id);
    return s ? nodeOf(g, view, s) : viewElementTerm(g, view, id, BOX_TYPES);
}

/** Bounding box around some cards, groups, notes and view references of a view, with a margin (for "group the selection"). */
export function boundsOf(g: ModelGraph, viewId: string, ids: string[], margin = 40): Box | undefined {
    const view = viewTerm(g, viewId);
    if (!view) return undefined;
    const boxes = ids.map(id => boxSubject(g, view, id)).filter(n => !!n)
        .map(n => readBox(g, view, n!, placementKind(g, view, n!)?.equals(V.Frame) ? GROUP_SIZE : DEFAULT_SIZE));
    if (boxes.length === 0) return undefined;
    const x = Math.min(...boxes.map(n => n.x)) - margin, y = Math.min(...boxes.map(n => n.y)) - margin;
    const r = Math.max(...boxes.map(n => n.x + n.width)) + margin, b = Math.max(...boxes.map(n => n.y + n.height)) + margin;
    return { x, y, width: r - x, height: b - y };
}

/**
 * New bounds of cards and groups in a view (one drag or resize). A group that moves with the same size also
 * moves the cards and groups fully inside it, as in JSON Canvas.
 */
export function setBounds(g: ModelGraph, viewId: string, bounds: ({ id: string } & Partial<Box>)[]): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    // An element drawn without a placement gets one at the place where it was moved (an "in" or "one of" box: its list term).
    for (const b of bounds) {
        const s = cardTerm(g, b.id);
        if (s && !nodeOf(g, view, s)) addToView(g, viewId, b.id, { x: 0, y: 0 });
    }
    const moved = rdf.termSet<Quad_Subject>();
    for (const b of bounds) {
        const s = boxSubject(g, view, b.id);
        if (s) moved.add(s);
    }
    const members = g.subjects(P.type, V.Placement, view).filter(n => g.objects(n, V.element, view).length > 0);
    // The move of each box placement: an edge whose two ends move the same keeps its bends with them.
    const delta = new Map<string, { dx: number; dy: number }>();
    for (const b of bounds) {
        const grp = viewElementTerm(g, view, b.id, [V.Frame]);
        if (!grp || b.x === undefined || b.y === undefined) continue;
        const box = readBox(g, view, grp, GROUP_SIZE);
        if ((b.width !== undefined && b.width !== box.width) || (b.height !== undefined && b.height !== box.height)) continue;
        const dx = b.x - box.x, dy = b.y - box.y;
        for (const m of members) {
            if (moved.has(m) || m.equals(grp)) continue;
            const mb = readBox(g, view, m);
            if (!inside(mb, box)) continue;
            writeBox(g, view, m, { x: mb.x + dx, y: mb.y + dy });
            moved.add(m);
            delta.set(m.value, { dx, dy });
        }
    }
    for (const b of bounds) {
        const s = boxSubject(g, view, b.id);
        if (!s) continue;
        const isGroup = !!placementKind(g, view, s)?.equals(V.Frame);
        if (b.x !== undefined && b.y !== undefined) {
            const old = readBox(g, view, s, isGroup ? GROUP_SIZE : DEFAULT_SIZE);
            delta.set(s.value, { dx: b.x - old.x, dy: b.y - old.y });
        }
        writeBox(g, view, s, isGroup ? {
            ...b,
            width: b.width === undefined ? undefined : Math.max(MIN_GROUP.width, b.width),
            height: b.height === undefined ? undefined : Math.max(MIN_GROUP.height, b.height)
        } : b);
    }
    moveVertices(g, view, delta);
    return ok(undefined);
}
