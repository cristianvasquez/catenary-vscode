// Figure placements after a command and Show as Line, over the quads of one view and the model facts: pure, synchronous, no graph, no store.
// Oracle until the cutover: src/catenary/rdf/figure-edits.ts. rekeyLists is not here: it runs on changes of the shapes, which no view command makes.
import type { NamedNode, Term } from '@rdfjs/types';
import { LEAF_SUFFIX } from '../catenary/model/diagram-schema';
import { iriId, unescapeId } from '../catenary/model/ids';
import { nkey, type NTerm } from '../catenary/model/notation-graph';
import { arrival, NotationPlacement, Placements, removal, ViewFigures } from '../catenary/model/notation-join';
import { sha256Hex } from '../catenary/model/sha256';
import { Range, rangeText } from '../catenary/model/shapes-doc';
import { ONE_OF_WIDTH, pillSize } from '../catenary/model/shapes-schema';
import { NS } from '../catenary/model/terms';
import { keyTerm } from '../catenary/rdf/notations';
import type { Facts } from './facts';
import * as ops from './ops';
import { elementId, P, rdf, V } from './terms';
import type { ViewQuads } from './view-quads';

/** The figures of a view in its present state; `also`: terms that the view does not place but that the caller asks about. */
export type FiguresOf = (viewIri: string, also?: NTerm[]) => ViewFigures;

const SH = NS.sh, RDF_FIRST = NS.rdf + 'first', RDF_REST = NS.rdf + 'rest';

// --- stable list terms ---------------------------------------------------------------------------

const hash = (holder: string, predicate: string, n: number) => rdf.namedNode(`${ops.LIST_PREFIX}${sha256Hex(`${holder} ${predicate} ${n}`).slice(0, 12)}`);

/** The members of an RDF list of the shapes. */
function members(facts: Facts, head: Term): Term[] {
    const out: Term[] = [], seen = new Set<string>();
    for (let n: Term | undefined = head; n && !seen.has(n.value); n = facts.shapesMatch(n.value, RDF_REST)[0]?.object) {
        seen.add(n.value);
        const f = facts.shapesMatch(n.value, RDF_FIRST)[0]?.object;
        if (f) out.push(f);
    }
    return out;
}

/** The term of a list: `<holder> <predicate> <n>`, n the position of the list among the lists of that holder and predicate, by member text. */
function listTermOf(facts: Facts, holder: string, predicate: string, head: Term): NamedNode {
    const text = (h: Term) => members(facts, h).map(x => x.value).join(' ');
    const heads = facts.shapesMatch(holder, predicate).map(q => q.object).filter(h => facts.shapesMatch(h.value, RDF_FIRST).length > 0);
    const n = heads.sort((x, y) => text(x).localeCompare(text(y))).findIndex(h => h.value === head.value) + 1;
    return hash(holder, predicate, Math.max(1, n));
}

/** The list term of a logical constraint id `c-<operator>-<shape>-<n>`. sh:not has no list (a «not» row): undefined. */
function constraintTerm(cid: string): NamedNode | undefined {
    const m = /^c-(xone|or|and)-([A-Za-z0-9_]+)-(\d+)$/.exec(cid);
    const shape = m && unescapeId(m[2]);
    return shape ? hash(shape, SH + m[1], Number(m[3])) : undefined;
}

/** The list term of the "in" or "one of" box of a property shape (its sh:in or sh:or list). */
function rangeListTerm(facts: Facts, property: string): NamedNode | undefined {
    for (const p of [SH + 'in', SH + 'or']) {
        const head = facts.shapesMatch(property, p)[0]?.object;
        if (head) return listTermOf(facts, property, p, head);
    }
    return undefined;
}

/** The Pill mark of a property in this view. */
function pillOf(view: ViewQuads, property: NamedNode): NamedNode | undefined {
    return view.match(null, V.of, property).map(q => q.subject).find(m => view.has(m, P.type, V.Pill) && ops.nodeOf(view, m)) as NamedNode | undefined;
}

/** The term of a diagram id for removal or movement: a Pill mark, a hub, a list box, or the element of the id. */
export function figureTermOf(view: ViewQuads, facts: Facts, id: string): NamedNode | undefined {
    const shapes = facts.shapes.model;
    if (id.startsWith('c-')) return constraintTerm(id);
    const leaf = id.endsWith(LEAF_SUFFIX) ? id.slice(0, -LEAF_SUFFIX.length) : undefined;
    const p = shapes.properties[leaf ?? id] ?? Object.values(shapes.properties).find(x => x.uri && iriId(x.uri) === (leaf ?? id));
    if (leaf !== undefined && p?.uri) return pillOf(view, rdf.namedNode(p.uri)) ?? rangeListTerm(facts, p.uri);
    if (p?.constraint) return constraintTerm(p.constraint);
    return ops.cardTerm(view, facts, id);
}

// --- the post-step ----------------------------------------------------------------------------------

const key = (t: Term): string => t.termType === 'Quad'
    ? `<<(${key(t.subject)} ${key(t.predicate)} ${key(t.object)})>>`
    : t.termType === 'NamedNode' ? `<${t.value}>` : JSON.stringify([t.value]);

/** The term of a placed key: an IRI (a line, a hub, a box); statements are placed by placeConnectors. */
const iriOfKey = (k: string) => /^<([^<>]*)>$/.exec(k)?.[1];

/**
 * After a command, on this view: the removal and arrival rules for the placements that the command changed. `arrivals` false: the
 * command placed a target from a property (Show as Line): no arrival. `figures`: the figures of the view as it is now.
 */
export function syncFigures(view: ViewQuads, facts: Facts, figures: FiguresOf, arrivals: boolean): void {
    // A placement whose element changes (a new IRI) is not an arrival and not a removal: pair by placement subject.
    const placed = { add: new Map<string, Term>(), remove: new Map<string, Term>() };
    for (const { op, quad: q } of view.steps()) {
        if (V.element.equals(q.predicate) || P.reifies.equals(q.predicate)) placed[op].set(q.subject.value, q.object);
    }
    const keysOf = (op: 'add' | 'remove') => {
        const other = placed[op === 'add' ? 'remove' : 'add'];
        return [...placed[op]].filter(([k]) => !other.has(k)).map(([, element]) => key(element));
    };
    const added = keysOf('add'), left = keysOf('remove');
    if (!added.length && !left.length) return;

    const vf = figures(view.graph.value, left.map(keyTerm));
    const gone = new Set<string>(), add = new Set<string>();
    // Removal: the state before the command is the state after it, with the removed placements.
    if (left.length) {
        const before: Placements = new Map(vf.placed);
        for (const k of left) before.set(k, { iri: '', simple: false, keptByLines: false } as NotationPlacement);
        for (const k of left) for (const x of removal(vf.derivation.figures, before, keyTerm(k))) if (!left.includes(x) && vf.placed.has(x)) gone.add(x);
    }
    const now: Placements = new Map([...vf.placed].filter(([k]) => !gone.has(k)));
    for (const k of added) {
        if (!now.has(k)) continue;
        // With arrivals off, an added box still draws its own lines to the shown cards: the part lines without nt:from (they start at
        // the box because they are its parts, as the alternatives of a "one of" box). A line with nt:from (a property of a card) is not.
        const box = vf.derivation.figures.find(f => nkey(f.placedAs) === k);
        const ownPart = (x: string) => Boolean(box?.rows.some(r => r.part?.fs.kind === 'Line' && !r.part.startValues.length
            && r.part.starts.includes(box) && nkey(r.part.placedAs) === x));
        for (const x of arrival(vf.derivation.figures, now, keyTerm(k))) if (!now.has(x) && iriOfKey(x) && (arrivals || ownPart(x))) add.add(x);
    }
    for (const k of gone) { const iri = iriOfKey(k); if (iri) ops.dropFromView(view, facts, rdf.namedNode(iri)); else removeStatementPlacement(view, facts, k); }
    for (const k of add) if (!ops.nodeOf(view, rdf.namedNode(iriOfKey(k)!))) ops.addPlacement(view, facts, rdf.namedNode(iriOfKey(k)!));
}

/** Remove the placement of a statement key from this view. */
function removeStatementPlacement(view: ViewQuads, facts: Facts, k: string): void {
    const t = keyTerm(k);
    if (t.termType !== 'Triple') return;
    const e = ops.edgeOf(view, rdf.namedNode(t.subject.value), rdf.namedNode(t.predicate.value), rdf.namedNode(t.object.value));
    if (e) ops.removeTree(view, facts, e);
}

// --- Show as Line ------------------------------------------------------------------------------------

/**
 * Show a property shape as a line in this view (⇥ on a row, Show as Edge): the box of its end, if the view does not show it, at `at`,
 * with view:keptByLines (it leaves with its last line); then the line. A member of a logical constraint: its hub, with the boxes of the
 * member ends. A sh:not member: a line with the tag «not». A datatype, node-kind or open end gets a Pill mark.
 * `id`: a property shape id or a constraint id. Returns an error text, or undefined.
 */
export function showAsLine(view: ViewQuads, facts: Facts, viewId: string, id: string, at: { x: number; y: number }): string | undefined {
    if (ops.viewTerm(view, facts, viewId)?.value !== view.graph.value) return 'The view does not exist.';
    const shapes = facts.shapes.model;
    const constraint = id.startsWith('c-') ? shapes.constraints[id] : undefined;
    // A sh:not constraint has no hub: its only member is a line with the tag «not», as a property without a constraint.
    const notMember = constraint?.operator === 'not' ? shapes.properties[constraint.members[0] ?? ''] : undefined;
    const p = notMember ?? (constraint ? undefined : shapes.properties[id]);
    const cid = constraint?.id ?? p?.constraint;
    if (cid && !cid.startsWith('c-not-')) {
        const hub = constraintTerm(cid);
        if (!hub) return 'This logical constraint has no list.';
        let i = 0;
        for (const m of shapes.constraints[cid]?.members ?? []) {
            const mp = shapes.properties[m];
            if (mp) i += placeEnd(view, facts, mp.uri!, mp.range, { x: at.x, y: at.y + i * 120 }) ? 1 : 0;
        }
        if (!ops.nodeOf(view, hub)) ops.addPlacement(view, facts, hub);
        return undefined;
    }
    if (!p?.uri) return 'This property shape has no IRI. Reload the shapes file: the editor replaces blank nodes by IRIs.';
    placeEnd(view, facts, p.uri, p.range, at);
    const line = rdf.namedNode(p.uri);
    if (!ops.nodeOf(view, line)) ops.addPlacement(view, facts, line);
    return undefined;
}

/** Place the end box of a property line when this view does not show it. Returns true when it placed a box. */
function placeEnd(view: ViewQuads, facts: Facts, property: string, range: Range, at: { x: number; y: number }): boolean {
    const shapes = facts.shapes.model;
    let term: NamedNode | undefined;
    const pill = range.kind === 'datatype' || range.kind === 'nodeKind' || range.kind === 'any';
    if (pill) {
        if (pillOf(view, rdf.namedNode(property))) return false;
        term = ops.newMark(view, facts, V.Pill, [[V.of, rdf.namedNode(property)]]);
    } else if (range.kind === 'in' || range.kind === 'or') term = rangeListTerm(facts, property);
    else if (range.kind === 'node') term = shapes.nodeShapes[range.shape] ? rdf.namedNode(shapes.nodeShapes[range.shape].uri) : undefined;
    else if (range.kind === 'class') {
        // Several node shapes of the class: one that the view shows, else the first by ID (as the engine, joinState).
        const candidates = Object.values(shapes.nodeShapes).filter(n => n.targetClass === range.class).sort((a, b) => a.id.localeCompare(b.id));
        const shape = candidates.find(n => ops.nodeOf(view, rdf.namedNode(n.uri))) ?? candidates[0];
        term = rdf.namedNode(shape?.uri ?? range.class);
    } else if (range.kind === 'scheme') term = range.schemes[0] ? rdf.namedNode(range.schemes[0]) : undefined;
    else if (range.kind === 'collection') term = rdf.namedNode(range.collection);
    if (!term || ops.nodeOf(view, term)) return false;
    // A list box ("in", "one of") grows to its rows; an "in" box is drawn as a pill of its text.
    const size = pill ? pillSize(rangeText(shapes, range))
        : ops.cardTerm(view, facts, elementId(term)) && !term.value.startsWith(ops.LIST_PREFIX) ? ops.cardSize(view, facts, elementId(term)) : { width: ONE_OF_WIDTH, height: 120 };
    const node = ops.addPlacement(view, facts, term);
    ops.writeBox(view, facts, node, { ...at, ...size });
    view.add(node, V.keptByLines, rdf.literal('true', rdf.namedNode(NS.xsd + 'boolean')));
    return true;
}
