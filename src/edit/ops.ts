// View placement and mark edits over the quads of one view and the model facts: pure, synchronous, no graph, no store.
// Oracle until the cutover: src/catenary/rdf/ops.ts. An op reads this view and the facts, and writes only this view (decision 6).
import type { NamedNode, Quad, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import { centered, gridPositions, ViewElementPatch } from '../catenary/model/commands';
import { Box, DEFAULT_COLLECTION_SIZE, DEFAULT_NOTE_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE, EdgeLayout, formatVertices, GROUP_SIZE, inside, MIN_GROUP, parseVertices } from '../catenary/model/doc';
import { nkey } from '../catenary/model/notation-graph';
import type { ViewFigures } from '../catenary/model/notation-join';
import { alternativesOf, rangeText } from '../catenary/model/shapes-doc';
import { pills, pillSize, targetSize } from '../catenary/model/shapes-schema';
import { NS, TermJSON } from '../catenary/model/terms';
import type { Facts } from './facts';
import { elementId, elementTerm, isSkolem, newMarkIri, P, placementIri, rdf, relationId, relationTriple, termKey, V } from './terms';
import type { ViewQuads } from './view-quads';

export type Result<T = void> = { ok: true; value: T; changed?: false; message?: string } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = (error: string): Result<never> => ({ ok: false, error });

/** A command that has nothing to change: ok, no patch, no undo step, no write. It has no value. */
export const noop = (message: string): Result<never> => ({ ok: true, value: undefined as never, changed: false, message });

/** An id that names no element of this kind: the caller gave a wrong id, or the element was deleted. */
export const gone = (what: string, id: string): Result<never> => fail(`No ${what} with the id ${id}: the id is wrong or the ${what} was deleted.`);

const integer = (n: number) => rdf.literal(String(Math.round(n) || 0), rdf.namedNode(NS.xsd + 'integer'));

const same = (a: Term, b: Term) => termKey(a) === termKey(b);

// ------------------------------------------------------------------ view statements (rdf/views.ts, one view)

/** The placement of an element in this view. */
function nodeOf(view: ViewQuads, element: Term): Quad_Subject | undefined {
    return view.subjects(V.element, element).find(s => view.has(s, P.type, V.Placement));
}

/** The placement of a connector (a relation, an arrow) in this view: the placement that reifies the triple `s p o`. */
function edgeOf(view: ViewQuads, s: Term, p: Term, o: Term): Quad_Subject | undefined {
    return view.subjects(P.reifies, rdf.quad(s as Quad_Subject, p as NamedNode, o as Quad_Object)).find(e => view.has(e, P.type, V.Placement));
}

/** The triple of a placement of a connector in this view (the triple term that it reifies), or undefined. */
function connectorOf(view: ViewQuads, placement: Term): Quad | undefined {
    return view.match(placement, P.reifies).find(q => q.object.termType === 'Quad')?.object as Quad | undefined;
}

/** The placements of connectors in this view, with their triples. */
function connectorPlacements(view: ViewQuads): { placement: Quad_Subject; triple: Quad }[] {
    return view.match(null, P.reifies).filter(q => q.object.termType === 'Quad' && view.has(q.subject, P.type, V.Placement))
        .map(q => ({ placement: q.subject, triple: q.object as Quad }));
}

/** A new mark IRI `<view>/m/<id>` that this view does not use. */
function markIri(view: ViewQuads): NamedNode {
    for (;;) {
        const t = newMarkIri(view.graph.value);
        if (!view.match(t).length && !view.match(null, null, t).length) return t;
    }
}

/** This view, when `id` names it and its graph has a view:View subject. */
function thisView(view: ViewQuads, id: string): NamedNode | undefined {
    return elementTerm(id)?.value === view.graph.value && view.match(null, P.type, V.View).length > 0 ? view.graph : undefined;
}

/** A view: this view (its statements), or another view of the workspace (the facts). */
function isViewTerm(view: ViewQuads, facts: Facts, t: Term | undefined): t is NamedNode {
    if (t?.termType !== 'NamedNode') return false;
    return t.value === view.graph.value ? view.match(null, P.type, V.View).length > 0 : facts.isView(t.value);
}

// ------------------------------------------------------------------ resolve ids

export function instanceTerm(_view: ViewQuads, facts: Facts, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t && facts.isInstance(t.value) ? t : undefined;
}

/** A node shape, value set or property shape with an IRI: drawn as a shape element. */
function shapeCardTerm(facts: Facts, id: string): NamedNode | undefined {
    return elementTerm(id) ? facts.shapesCard(id) : undefined;
}

/** The element of a card in a view: a shape element, else an instance, else a class pill, else a list figure. A shape wins when the same IRI is both. */
export function cardTerm(view: ViewQuads, facts: Facts, id: string): NamedNode | undefined {
    return shapeCardTerm(facts, id) ?? instanceTerm(view, facts, id) ?? pillTerm(facts, id) ?? listTerm(id);
}

/** The term of a list figure ("in", "one of", hub): `urn:trellis:list:<hash>`. It has no statements. */
export const LIST_PREFIX = 'urn:trellis:list:';

function listTerm(id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.value.startsWith(LIST_PREFIX) ? t : undefined;
}

/** The IRI of a pill (`pills`): a datatype, node kind or class without a node shape that is the range of a property shape. */
function pillTerm(facts: Facts, id: string): NamedNode | undefined {
    const pill = pills(facts.shapes.model).get(id);
    return pill && rdf.namedNode(pill.iri);
}

/** This view or another view of the workspace. */
export function viewTerm(view: ViewQuads, facts: Facts, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return isViewTerm(view, facts, t) ? t : undefined;
}

/** Types of marks: elements kept by their placements. */
const MARK_TYPES = [V.Frame, V.Note, V.FileRef, V.EntityGroup, V.Pill];

/** View-owned elements, by kind: the placement of a mark (its type), of a view (`V.View`: a view reference), of an arrow (`V.arrow`). */
const VIEW_ELEMENT_TYPES = [...MARK_TYPES, V.View, V.arrow];

/** The element of a placement in this view. */
function elementOf(view: ViewQuads, placement: Term): NamedNode | undefined {
    const e = view.objects(placement, V.element)[0];
    return e?.termType === 'NamedNode' ? e : undefined;
}

/**
 * The element id that an id stands for (a placement is not its element): the placement of a card in this view gives its element, the
 * placement of a relation gives the relation. Other ids stay: an element id, and the placement of a mark, a view or an arrow.
 */
export function elementIdOf(view: ViewQuads, facts: Facts, id: string): string {
    const t = elementTerm(id);
    if (!t || !view.has(t, P.type, V.Placement)) return id;
    const e = elementOf(view, t);
    if (e) return markType(view, e) || isViewTerm(view, facts, e) ? id : elementId(e);
    const c = connectorOf(view, t);
    return c && !V.arrow.equals(c.predicate) ? relationId(c.subject as NamedNode, c.predicate as NamedNode, c.object as NamedNode) : id;
}

/** The type of a mark of this view (MARK_TYPES), or undefined. */
function markType(view: ViewQuads, e: Term): NamedNode | undefined {
    return MARK_TYPES.find(t => view.has(e, P.type, t));
}

/** Kind of a placement: the type of its mark, `V.View` for a placement of a view, `V.arrow` for an arrow, undefined for a card or relation. */
function placementKind(view: ViewQuads, facts: Facts, placement: Term): NamedNode | undefined {
    const e = elementOf(view, placement);
    if (!e) return connectorOf(view, placement) && V.arrow.equals(connectorOf(view, placement)!.predicate) ? V.arrow : undefined;
    return isViewTerm(view, facts, e) ? V.View : markType(view, e);
}

/** A view-owned element of one of `types` in this view: a placement whose kind is in `types`, or an arrow. */
export function viewElementTerm(view: ViewQuads, facts: Facts, id: string, types = VIEW_ELEMENT_TYPES): NamedNode | undefined {
    const t = elementTerm(id);
    if (!t || !view.has(t, P.type, V.Placement)) return undefined;
    const kind = placementKind(view, facts, t);
    return kind && types.some(x => x.equals(kind)) ? t : undefined;
}

/** A new mark of `type` in this view, with its content statements. */
export function newMark(view: ViewQuads, _facts: Facts, type: NamedNode, content: [NamedNode, Quad_Object][]): NamedNode {
    const m = markIri(view);
    view.add(m, P.type, type);
    for (const [p, o] of content) view.add(m, p, o);
    return m;
}

/** A new placement of an element in this view, with a box. */
function newPlacement(view: ViewQuads, element: NamedNode, box: Partial<Box>, color?: string): NamedNode {
    const p = place(view, element);
    setBox(view, p, box);
    if (color) writeString(view, p, V.color, color);
    return p;
}

/** Remove a placement. A mark of this view without placements in this view is deleted; so is an arrow of this view without placements. */
function removePlacement(view: ViewQuads, placement: Quad_Subject): void {
    const e = elementOf(view, placement);
    const t = connectorOf(view, placement);
    const arrow = t && V.arrow.equals(t.predicate) ? [t.subject, t.object] : undefined;
    view.removeMatches(placement);
    if (e && markType(view, e) && view.match(null, V.element, e).length === 0) view.removeMatches(e);
    if (arrow && !arrowPlacements(view, arrow[0], arrow[1]).length) view.removeMatches(arrow[0], V.arrow, arrow[1]);
}

/** The placements of the arrow `s view:arrow o` in this view. */
function arrowPlacements(view: ViewQuads, s: Term, o: Term): Quad[] {
    return view.match(null, P.reifies, rdf.quad(s as Quad_Subject, V.arrow, o as Quad_Object)).filter(q => view.has(q.subject, P.type, V.Placement));
}

export function relationTerms(_view: ViewQuads, facts: Facts, id: string): { s: NamedNode; p: NamedNode; o: NamedNode } | undefined {
    const r = relationTriple(id);
    return r && facts.isInstance(r.s.value) && facts.isInstance(r.o.value) && facts.has(r.s.value, r.p.value, r.o.value) ? r : undefined;
}

function place(view: ViewQuads, placed: NamedNode | Quad): NamedNode {
    const p = placementIri(view.graph.value, placed);
    view.add(p, P.type, V.Placement);
    view.add(p, V.view, view.graph);
    if (placed.termType === 'Quad') view.add(p, P.reifies, placed); else view.add(p, V.element, placed);
    return p;
}

/**
 * A new placement of `placed` in this view (`placementIri`): its type, its view and what it places, `view:element` for an element and
 * `rdf:reifies` for a triple (a connector).
 */
export function addPlacement(view: ViewQuads, _facts: Facts, placed: NamedNode | Quad): NamedNode {
    return place(view, placed);
}

/** Owned by `s`: an object IRI that was a blank node in its file, is not an instance, has statements in this view, and that no other subject of this view refers to. */
function ownedBy(view: ViewQuads, facts: Facts, o: Term, s: Term): o is NamedNode {
    return isSkolem(o) && !facts.isInstance(o.value) && view.match(o).length > 0 && view.match(null, null, o).every(q => same(q.subject, s));
}

/** Remove the statements of a subject in this view, and of the objects that it owns. */
export function removeTree(view: ViewQuads, facts: Facts, s: Term): void {
    const owned = view.match(s).map(q => q.object).filter(o => ownedBy(view, facts, o, s));
    view.removeMatches(s);
    for (const o of owned) removeTree(view, facts, o);
}

/** Remove the node of an instance (or node shape), its edge layouts and its collection membership from this view. */
export function dropFromView(view: ViewQuads, facts: Facts, s: NamedNode): void {
    const node = nodeOf(view, s);
    if (node) removePlacement(view, node);
    view.removeMatches(null, V.member, s);
    for (const c of connectorPlacements(view)) if (same(c.triple.subject, s) || same(c.triple.object, s)) removeTree(view, facts, c.placement);
}

// ------------------------------------------------------------------ view membership and layout

function readBox(view: ViewQuads, s: Term, fallback = DEFAULT_SIZE): Box {
    return {
        x: view.number(s, V.x, 0), y: view.number(s, V.y, 0),
        width: view.number(s, V.width, fallback.width), height: view.number(s, V.height, fallback.height)
    };
}

function setBox(view: ViewQuads, s: Quad_Subject, box: Partial<Box>): void {
    for (const k of ['x', 'y', 'width', 'height'] as const) {
        const v = box[k];
        if (typeof v === 'number' && isFinite(v)) view.set(s, V[k], integer(v));
    }
}

export function writeBox(view: ViewQuads, _facts: Facts, s: Quad_Subject, box: Partial<Box>): void {
    setBox(view, s, box);
}

function writeString(view: ViewQuads, s: Quad_Subject, p: NamedNode, v: string | undefined): void {
    view.set(s, p, v ? rdf.literal(v) : undefined);
}

/** Size of a new node shape card (name and target class); the card grows with its rows. */
const SHAPE_CARD_SIZE = { width: 520, height: 120 };

/** Size of a value set node (concepts as chips) and of the target node of a property drawn out of its card. */
const VALUE_SET_SIZE = { width: 320, height: 160 };

function shapesCardSize(facts: Facts, id: string): { width: number; height: number } {
    const idx = facts.shapes;
    const property = idx.model.properties[id];
    return idx.valueSet.has(id) ? VALUE_SET_SIZE : property ? targetSize(idx.model, property, alternativesOf(property.range).length) : SHAPE_CARD_SIZE;
}

/** Size of a new card: a shape element or a value set (also a scheme or collection in a data file) as `shapesCardSize`, else DEFAULT_SIZE. */
export function cardSize(view: ViewQuads, facts: Facts, id: string): { width: number; height: number } {
    if (shapeCardTerm(facts, id) || facts.shapes.valueSet.has(id)) return shapesCardSize(facts, id);
    const model = facts.shapes.model, pill = !instanceTerm(view, facts, id) && pills(model).get(id);
    return pill ? pillSize(rangeText(model, pill.range)) : DEFAULT_SIZE;
}

export function addToView(view: ViewQuads, facts: Facts, viewId: string, instanceId: string, at: { x: number; y: number }, size?: { width: number; height: number }): Result {
    const v = thisView(view, viewId);
    if (!v) return gone('view', viewId);
    size ??= cardSize(view, facts, instanceId);
    const s = cardTerm(view, facts, instanceId);
    if (!s) return fail('A view shows instances, node shapes, concept schemes, collections, properties with an IRI and pills.');
    if (nodeOf(view, s)) return fail(`"${facts.label(s.value)}" is already in view "${facts.viewLabel(v.value)}".`);
    const node = place(view, s);
    setBox(view, node, { ...at, ...size });
    return ok(undefined);
}

/** The placement of a connector (a relation, an arrow) in this view; a new one if there is none. */
function placeConnector(view: ViewQuads, s: NamedNode, p: NamedNode, o: NamedNode): Quad_Subject {
    return edgeOf(view, s, p, o) ?? place(view, rdf.quad(s, p, o));
}

/** The line placement of a property shape in this view: the property drawn as an edge. */
function lineOf(view: ViewQuads, facts: Facts, propertyId: string): Quad_Subject | undefined {
    const p = facts.shapes.model.properties[propertyId];
    return p?.uri ? nodeOf(view, rdf.namedNode(p.uri)) : undefined;
}

/**
 * Sides, vertices or color of an edge in this view ('' / undefined / [] remove the value): a relation, or a property shape drawn as an
 * edge (its line placement must exist). `hidden`: true removes the placement of the relation, false places it. A property shape takes no `hidden`.
 */
export function setEdgeLayout(view: ViewQuads, facts: Facts, viewId: string, relationId: string, patch: Partial<Omit<EdgeLayout, 'relation'>>): Result {
    const v = thisView(view, viewId), r = relationTerms(view, facts, relationId);
    if (!v) return gone('view', viewId);
    let e: Quad_Subject;
    if (r) {
        if (patch.hidden) {
            const placed = edgeOf(view, r.s, r.p, r.o);
            if (placed) removeTree(view, facts, placed);
            return ok(undefined);
        }
        e = placeConnector(view, r.s, r.p, r.o);
    } else {
        const line = lineOf(view, facts, relationId);
        if (!line) return gone('relation', relationId);
        if (patch.hidden) return fail('A property edge cannot be hidden. Show it as a row.');
        e = line;
    }
    for (const k of ['fromSide', 'toSide', 'color'] as const) if (k in patch) writeString(view, e, V[k], patch[k]);
    if ('vertices' in patch) writeString(view, e, V.vertices, formatVertices(patch.vertices));
    return ok(undefined);
}

type Delta = { dx: number; dy: number };

/**
 * The bends of each edge placement of this view whose both ends move by one delta, moved by that delta. A connector (rdf:reifies): its
 * ends are the placements of the statement ends. A property line (view:element): its ends are the placements of its start and end figures
 * (`figures`, the join of the view); a shared property shape has one line for each shown owner, and its one placement moves once, only
 * when every start and the end move by one delta.
 */
function moveVertices(view: ViewQuads, delta: Map<string, Delta>, figures: ViewFigures): void {
    if (![...delta.values()].some(d => d.dx || d.dy)) return;
    const move = (e: Quad_Subject, da: Delta | undefined, db: Delta | undefined) => {
        if (!da || !db || da.dx !== db.dx || da.dy !== db.dy || (!da.dx && !da.dy)) return;
        const points = parseVertices(view.objects(e, V.vertices)[0]?.value);
        if (points) writeString(view, e, V.vertices, formatVertices(points.map(p => ({ x: p.x + da.dx, y: p.y + da.dy }))));
    };
    const lines: Quad_Subject[] = [];
    for (const e of view.subjects(V.vertices)) {
        const t = connectorOf(view, e);
        if (!t) { lines.push(e); continue; }
        const a = nodeOf(view, t.subject), b = nodeOf(view, t.object);
        move(e, a && delta.get(a.value), b && delta.get(b.value));
    }
    if (lines.length === 0) return;
    const placementOf = (f: { placedAs: TermJSON } | undefined) => f && figures.placed.get(nkey(f.placedAs))?.iri;
    // The deltas of the ends of each line placement: all must be equal for the bends to move.
    const ends = new Map<string, (Delta | undefined)[]>();
    for (const l of figures.join.lines) {
        const own = placementOf(l.figure);
        if (!own || !lines.some(x => x.value === own)) continue;
        const da = delta.get(placementOf(l.start) ?? '');
        const list = ends.get(own) ?? ends.set(own, []).get(own)!;
        list.push(da, delta.get(placementOf(l.end) ?? ''));
    }
    for (const e of lines) {
        const list = ends.get(e.value);
        if (!list?.length) continue;
        const equal = (a: Delta | undefined, b: Delta | undefined) => !!a && !!b && a.dx === b.dx && a.dy === b.dy;
        move(e, list[0], list.every(d => equal(d, list[0])) ? list[0] : undefined);
    }
}

/** Apply Layout: the sides and bends of every edge placement of this view go. */
export function clearEdgeLayouts(view: ViewQuads, _facts: Facts, viewId: string): Result {
    if (!thisView(view, viewId)) return gone('view', viewId);
    for (const p of [V.fromSide, V.toSide, V.vertices]) for (const e of view.subjects(p)) view.set(e, p, undefined);
    return ok(undefined);
}

export function hideEdge(view: ViewQuads, facts: Facts, viewId: string, relationId: string, hidden: boolean): Result {
    return setEdgeLayout(view, facts, viewId, relationId, { hidden });
}

/**
 * Runs after each command, on this view. A new placement of an element places its connectors (relations of the model, arrows of
 * this view) to the elements already placed in this view. A new arrow of this view is placed when this view places both ends.
 */
export function placeConnectors(view: ViewQuads, facts: Facts): void {
    const placed: NamedNode[] = [], arrows: Quad[] = [];
    for (const { op, quad: q } of view.steps()) {
        if (op !== 'add') continue;
        if (V.element.equals(q.predicate) && q.object.termType === 'NamedNode') placed.push(q.object);
        else if (V.arrow.equals(q.predicate)) arrows.push(q);
    }
    if (placed.length) {
        const elements = [...new Set(view.match(null, V.element).filter(q => q.object.termType === 'NamedNode' && view.has(q.subject, P.type, V.Placement)).map(q => q.object.value))];
        const relations = facts.statementsAmong(elements);
        for (const s of placed) {
            if (!nodeOf(view, s)) continue;
            const touching = [...relations.filter(q => same(q.subject, s) || same(q.object, s)), ...view.match(s, V.arrow), ...view.match(null, V.arrow, s)];
            for (const q of touching) {
                const other = same(q.subject, s) ? q.object : q.subject;
                if (other.termType === 'NamedNode' && q.object.termType === 'NamedNode' && nodeOf(view, other)) placeConnector(view, q.subject as NamedNode, q.predicate as NamedNode, q.object);
            }
        }
    }
    for (const q of arrows) {
        if (q.object.termType !== 'NamedNode' || !view.has(q.subject, q.predicate, q.object)) continue;
        if (nodeOf(view, q.subject) && nodeOf(view, q.object)) placeConnector(view, q.subject as NamedNode, V.arrow, q.object);
    }
}

// ------------------------------------------------------------------ groups (layout only)

export function createGroup(view: ViewQuads, facts: Facts, viewId: string, label: string, rect: Box, color?: string): Result<string> {
    if (!thisView(view, viewId)) return gone('view', viewId);
    if (!label.trim()) return fail('The group name is empty.');
    const frame = newMark(view, facts, V.Frame, [[P.label, rdf.literal(label.trim())]]);
    const b = newPlacement(view, frame, { x: rect.x, y: rect.y, width: Math.max(MIN_GROUP.width, rect.width), height: Math.max(MIN_GROUP.height, rect.height) }, color);
    return ok(elementId(b));
}

// ------------------------------------------------------------------ notes and view references (view only)

export function createNote(view: ViewQuads, facts: Facts, viewId: string, text: string, at: { x: number; y: number }): Result<string> {
    if (!thisView(view, viewId)) return gone('view', viewId);
    const note = newMark(view, facts, V.Note, [[V.text, rdf.literal(text)]]);
    return ok(elementId(newPlacement(view, note, { ...at, ...DEFAULT_NOTE_SIZE })));
}

export function createViewReference(view: ViewQuads, facts: Facts, viewId: string, targetId: string, at: { x: number; y: number }): Result<string> {
    const v = thisView(view, viewId), target = viewTerm(view, facts, targetId);
    if (!v) return gone('view', viewId);
    if (!target) return gone('view', targetId);
    // A view reference is a placement of the view. A view places it once.
    if (nodeOf(view, target)) return fail(`View "${facts.viewLabel(target.value)}" is already in view "${facts.viewLabel(v.value)}".`);
    return ok(elementId(newPlacement(view, target, { ...at, ...DEFAULT_VIEW_REFERENCE_SIZE })));
}

/** A link box to a file: `file` is the path relative to the view file. */
export function createFileReference(view: ViewQuads, facts: Facts, viewId: string, file: string, at: { x: number; y: number }): Result<string> {
    if (!thisView(view, viewId)) return gone('view', viewId);
    if (!file.trim()) return fail('No file.');
    const ref = newMark(view, facts, V.FileRef, [[V.file, rdf.literal(file)]]);
    return ok(elementId(newPlacement(view, ref, { ...at, ...DEFAULT_VIEW_REFERENCE_SIZE })));
}

// ------------------------------------------------------------------ any element of a view

/**
 * Change one element of this view: its box, its color, and the field of its kind: display of a card, label of a group, text of a
 * note. A field that the element does not have is ignored. A relation takes only the color (its edge layout).
 * `expectedText` (a note) protects a local editor draft from overwriting another client's change.
 */
export function setViewElement(view: ViewQuads, facts: Facts, viewId: string, id: string, patch: ViewElementPatch, expectedText?: string): Result {
    if (!thisView(view, viewId)) return gone('view', viewId);
    if (relationTerms(view, facts, id)) return 'color' in patch ? setEdgeLayout(view, facts, viewId, id, { color: patch.color }) : ok(undefined);
    const s = boxSubject(view, facts, id) ?? viewElementTerm(view, facts, id, [V.arrow]);
    if (!s) return fail('The element is not in this view any more.');
    const arrow = !!placementKind(view, facts, s)?.equals(V.arrow);
    const kind = arrow ? undefined : placementKind(view, facts, s);
    const mark = kind && !kind.equals(V.View) ? elementOf(view, s) : undefined;
    const is = (type: NamedNode) => !!kind && kind.equals(type);
    let box: Partial<Box> = patch;
    if (is(V.Frame)) {
        if (patch.label !== undefined) {
            if (!patch.label.trim()) return fail('The group name is empty.');
            view.set(mark!, P.label, rdf.literal(patch.label.trim()));
        }
        box = {
            ...patch,
            width: patch.width === undefined ? undefined : Math.max(MIN_GROUP.width, patch.width),
            height: patch.height === undefined ? undefined : Math.max(MIN_GROUP.height, patch.height)
        };
    }
    if (is(V.Note)) {
        if (expectedText !== undefined && (view.match(mark!, V.text)[0]?.object.value ?? '') !== expectedText) {
            return fail('This note changed elsewhere. Copy your draft, then reopen it.');
        }
        if (patch.text !== undefined) view.set(mark!, V.text, rdf.literal(patch.text));
    }
    const card = !arrow && !kind;
    if (card && 'display' in patch) writeString(view, s, V.display, patch.display === 'simple' ? 'simple' : undefined);
    if (!arrow) setBox(view, s, box);
    if ('color' in patch) writeString(view, s, V.color, patch.color);
    return ok(undefined);
}

/**
 * Remove elements from this view. A card leaves the view (the model does not change), the edge of a relation hides, a collection
 * leaves with its members, and a view-owned element is deleted.
 */
export function removeViewElements(view: ViewQuads, facts: Facts, viewId: string, ids: string[]): void {
    if (!thisView(view, viewId)) return;
    for (const id of ids) {
        const card = cardTerm(view, facts, id);
        if (card) dropFromView(view, facts, card);
        else if (relationTerms(view, facts, id)) hideEdge(view, facts, viewId, id, true);
        else {
            const s = viewElementTerm(view, facts, id);
            if (!s) continue;
            const e = elementOf(view, s);
            if (e && placementKind(view, facts, s)?.equals(V.EntityGroup)) for (const m of view.objects(e, V.member)) dropFromView(view, facts, m as NamedNode);
            removePlacement(view, s);
        }
    }
}

// ------------------------------------------------------------------ arrows (view only)

/**
 * Arrow from one box of this view to another; one end is a note. The arrow is the statement `x view:arrow y` between the elements of the
 * boxes (in this view); a placement of it in this view shows it. Returns the id of the placement.
 */
export function createArrow(view: ViewQuads, facts: Facts, viewId: string, fromId: string, toId: string): Result<string> {
    if (!thisView(view, viewId)) return gone('view', viewId);
    const from = boxSubject(view, facts, fromId), to = boxSubject(view, facts, toId);
    if (!from || !to) return fail('An arrow connects two elements of the view.');
    if (same(from, to)) return fail('An arrow connects two different elements.');
    const isNote = (b: Term) => !!placementKind(view, facts, b)?.equals(V.Note);
    if (!isNote(from) && !isNote(to)) return fail('An arrow starts or ends at a note.');
    const x = elementOf(view, from)!, y = elementOf(view, to)!;
    if (edgeOf(view, x, V.arrow, y)) return fail('This arrow exists already.');
    view.add(x, V.arrow, y);
    return ok(elementId(placeConnector(view, x, V.arrow, y) as NamedNode));
}

/** Remove the placements of arrows whose ends this view does not place any more, or whose statement this view does not have. Runs after each command. */
export function pruneArrows(view: ViewQuads, _facts: Facts): void {
    for (const { placement, triple } of connectorPlacements(view)) {
        if (!V.arrow.equals(triple.predicate)) continue;
        const x = triple.subject, y = triple.object;
        if (!shownIn(view, x) || !shownIn(view, y) || !view.has(x, V.arrow, y)) removePlacement(view, placement);
    }
}

/** This view shows the element: its placement, or the placement of an entity group that has it as a member. */
function shownIn(view: ViewQuads, x: Term): boolean {
    return !!nodeOf(view, x) || view.match(null, V.member, x).some(q => !!nodeOf(view, q.subject));
}

// ------------------------------------------------------------------ collections (view only)

/**
 * A member of an entity group has no placement of its own while it is in the group: its placement goes, and so do the placements of
 * its relations (the group draws them as bundles). An arrow keeps its placement: it ends at the group.
 */
function unplaceMember(view: ViewQuads, facts: Facts, m: NamedNode): void {
    const node = nodeOf(view, m);
    if (node) removeTree(view, facts, node);
    for (const c of connectorPlacements(view)) {
        if (!V.arrow.equals(c.triple.predicate) && (same(c.triple.subject, m) || same(c.triple.object, m))) removeTree(view, facts, c.placement);
    }
}

/** New collection of instances of this view, at `rect`. The instances lose their placements; members of other collections leave them. */
export function createCollection(view: ViewQuads, facts: Facts, viewId: string, instanceIds: string[], rect: Box): Result<string> {
    if (!thisView(view, viewId)) return gone('view', viewId);
    // In the view: a card, or a member of an entity group of the view (it has no placement).
    const members = instanceIds.map(id => instanceTerm(view, facts, id)).filter((s): s is NamedNode => !!s && (!!nodeOf(view, s) || view.match(null, V.member, s).length > 0));
    if (members.length === 0) return fail('Select the cards to collect.');
    for (const m of members) view.removeMatches(null, V.member, m);
    const group = newMark(view, facts, V.EntityGroup, members.map(m => [V.member, m]));
    for (const m of members) unplaceMember(view, facts, m);
    return ok(elementId(newPlacement(view, group, rect)));
}

/** Instances join a collection. A member has no placement of its own (C1). */
export function addToCollection(view: ViewQuads, facts: Facts, viewId: string, id: string, instanceIds: string[]): Result {
    const c = thisView(view, viewId) && viewElementTerm(view, facts, id, [V.EntityGroup]);
    if (!c) return fail('No such collection.');
    const mark = elementOf(view, c)!;
    const members = instanceIds.map(i => instanceTerm(view, facts, i)).filter((s): s is NamedNode => !!s);
    if (members.length === 0) return fail('No such instance.');
    for (const m of members) {
        unplaceMember(view, facts, m);
        view.removeMatches(null, V.member, m);
        view.add(mark, V.member, m);
    }
    return ok(undefined);
}

/**
 * Take members (all without `instanceIds`) out of a collection. Their cards go next to it, on the right, in the order of their IRIs.
 * An empty collection is deleted.
 */
export function uncollect(view: ViewQuads, facts: Facts, viewId: string, id: string, instanceIds?: string[]): Result<string[]> {
    const c = thisView(view, viewId) && viewElementTerm(view, facts, id, [V.EntityGroup]);
    if (!c) return fail('No such collection.');
    const mark = elementOf(view, c)!;
    const members = (view.objects(mark, V.member).filter(m => !instanceIds || instanceIds.includes(elementId(m as NamedNode))) as NamedNode[])
        .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    const box = readBox(view, c, DEFAULT_COLLECTION_SIZE);
    const at = { x: box.x + box.width + 60 + DEFAULT_SIZE.width / 2, y: box.y + box.height / 2 };
    const places = members.length === 1 ? [centered(at)] : gridPositions(members.length, { x: at.x + DEFAULT_SIZE.width / 2, y: at.y });
    // A released member gets its placement again (an older view file can still have one).
    members.forEach((m, i) => {
        view.remove(rdf.quad(mark, V.member, m));
        setBox(view, nodeOf(view, m) ?? place(view, m), { ...places[i], ...DEFAULT_SIZE });
    });
    if (view.objects(mark, V.member).length === 0) removePlacement(view, c);
    return ok(members.map(m => elementId(m)));
}

const BOX_TYPES = [...MARK_TYPES, V.View];

/** The subject that holds the box of a card (by instance id), group, note, view reference or collection in this view. */
function boxSubject(view: ViewQuads, facts: Facts, id: string): Quad_Subject | undefined {
    const s = cardTerm(view, facts, id);
    return s ? nodeOf(view, s) : viewElementTerm(view, facts, id, BOX_TYPES);
}

/** Bounding box around some cards, groups, notes and view references of this view, with a margin (for "group the selection"). */
export function boundsOf(view: ViewQuads, facts: Facts, viewId: string, ids: string[], margin = 40): Box | undefined {
    if (!thisView(view, viewId)) return undefined;
    const boxes = ids.map(id => boxSubject(view, facts, id)).filter(n => !!n)
        .map(n => readBox(view, n!, placementKind(view, facts, n!)?.equals(V.Frame) ? GROUP_SIZE : DEFAULT_SIZE));
    if (boxes.length === 0) return undefined;
    const x = Math.min(...boxes.map(n => n.x)) - margin, y = Math.min(...boxes.map(n => n.y)) - margin;
    const r = Math.max(...boxes.map(n => n.x + n.width)) + margin, b = Math.max(...boxes.map(n => n.y + n.height)) + margin;
    return { x, y, width: r - x, height: b - y };
}

/**
 * New bounds of cards and groups in this view (one drag or resize). A group that moves with the same size also moves the cards and
 * groups fully inside it, as in JSON Canvas. `figures`: the figures of this view (the bends of property lines move with their ends).
 */
export function setBounds(view: ViewQuads, facts: Facts, viewId: string, bounds: ({ id: string } & Partial<Box>)[], figures: ViewFigures): Result {
    if (!thisView(view, viewId)) return gone('view', viewId);
    // An element drawn without a placement gets one at the place where it was moved (an "in" or "one of" box: its list term).
    for (const b of bounds) {
        const s = cardTerm(view, facts, b.id);
        if (s && !nodeOf(view, s)) addToView(view, facts, viewId, b.id, { x: 0, y: 0 });
    }
    const moved = new Set<string>();
    for (const b of bounds) {
        const s = boxSubject(view, facts, b.id);
        if (s) moved.add(termKey(s));
    }
    const members = view.subjects(P.type, V.Placement).filter(n => view.objects(n, V.element).length > 0);
    // The move of each box placement: an edge whose two ends move the same keeps its bends with them.
    const delta = new Map<string, Delta>();
    for (const b of bounds) {
        const grp = viewElementTerm(view, facts, b.id, [V.Frame]);
        if (!grp || b.x === undefined || b.y === undefined) continue;
        const box = readBox(view, grp, GROUP_SIZE);
        if ((b.width !== undefined && b.width !== box.width) || (b.height !== undefined && b.height !== box.height)) continue;
        const dx = b.x - box.x, dy = b.y - box.y;
        for (const m of members) {
            if (moved.has(termKey(m)) || same(m, grp)) continue;
            const mb = readBox(view, m);
            if (!inside(mb, box)) continue;
            setBox(view, m, { x: mb.x + dx, y: mb.y + dy });
            moved.add(termKey(m));
            delta.set(m.value, { dx, dy });
        }
    }
    for (const b of bounds) {
        const s = boxSubject(view, facts, b.id);
        if (!s) continue;
        const isGroup = !!placementKind(view, facts, s)?.equals(V.Frame);
        if (b.x !== undefined && b.y !== undefined) {
            const old = readBox(view, s, isGroup ? GROUP_SIZE : DEFAULT_SIZE);
            delta.set(s.value, { dx: b.x - old.x, dy: b.y - old.y });
        }
        setBox(view, s, isGroup ? {
            ...b,
            width: b.width === undefined ? undefined : Math.max(MIN_GROUP.width, b.width),
            height: b.height === undefined ? undefined : Math.max(MIN_GROUP.height, b.height)
        } : b);
    }
    moveVertices(view, delta, figures);
    return ok(undefined);
}
