// Render model edges and view routing controls; adapted from Catenary modeler/src/browser/diagram/edge-chrome.ts.
// Sizes marked "screen" are divided by the zoom, so they stay constant on screen.

import { VNode } from 'snabbdom';
import type { Side } from '../catenary/model/doc';
import { ARROW_PATHS, colorVars, s, vars } from './card-chrome';
import { Part, vocabularyParts } from './vocabulary-color';
import { Cubic, EdgeStyle, NORMAL, Pt, along, curveAt, curvePath, curveSegments, linePath, port, routeSides } from './edge-route';

export type { Pt } from './edge-route';
interface Box { x: number; y: number; width: number; height: number }

export interface EdgeProps {
    source: Box;
    target: Box;
    fromSide: Side | '';     // '' : the side that faces the first point of the route (a vertex, else the other card)
    toSide: Side | '';
    /** Bends of the route, from the source to the target. */
    vertices?: Pt[];
    lane: number;            // parallel edges between the same two cards (when `offsets` is absent)
    lanes: number;
    /** Port offsets along the sides (edge-route.ts fanOut): the edges of one side fan out. Absent: the lane offset. */
    offsets?: { from: number; to: number };
    zoom: number;
    name: string;
    details?: string;
    color: string;
    selected: boolean;
    hover: boolean;
    hidden: boolean;
    /** Shapes views: the label in parts (prefix muted, local name colored) and the cardinality badge. */
    parts?: Part[];
    /** Relation and bundle edges: the name in parts (vocabulary color), drawn at the place of `name`. */
    nameParts?: Part[];
    card?: string;
    invalid?: boolean;
    /** Return an ejected property to rows in all containing shape cards of this view. */
    canPutBack?: boolean;
    /** Informative arrow (from or to a note): dashed, no end handles. */
    arrow?: boolean;
    /** The dashed edge of a property shown as a row: no end handles, a button that shows the property as an edge. */
    latent?: boolean;
    /** A derived edge that shows a sh:targetSubjectsOf relation. */
    /** Source and target are the same box: without vertices, a loop above it. */
    self?: boolean;
    /** The route style. Default: curved. */
    style?: EdgeStyle;
}

const ARROW = 12;       // screen px
const VERTEX_R = 5;     // screen px, vertex handle radius
const LANE = 48;        // minimum screen-space lane pitch, including the cardinality badge
const LABEL = 18;       // model units; at least LABEL_MIN screen px
const LABEL_MIN = 11;

function arrowHead(tip: Pt, n: Pt, size: number): string {
    const base = { x: tip.x + n.x * size, y: tip.y + n.y * size };
    const w = size * 0.5;
    return `M${tip.x},${tip.y} L${base.x - n.y * w},${base.y + n.x * w} L${base.x + n.y * w},${base.y - n.x * w} Z`;
}

/**
 * `p1`, `p2`: the ports on the source and the target; `n1`, `n2`: the side normals there. `label`: the point of the label, the middle of
 * the route (logical constraints link to it). `tail`: a point near the target end (the cardinality badge). `points`: the polyline of the
 * route, port to port, for hit tests of the vertices.
 */
export interface EdgeGeometry { path: string; p1: Pt; p2: Pt; n1: Pt; n2: Pt; label: Pt; tail: Pt; points: Pt[] }

/**
 * The route from a port of the source through the vertices to a port of the target. curved: a smooth curve that leaves and
 * enters along the side normals; without vertices, a cubic Bézier between the ports (as Obsidian canvas draws it). direct: straight
 * segments. Parallel edges take lanes: a pitch on the ports that stays readable on screen. A self edge without vertices is an arch
 * above the top side, one lane higher for each parallel edge. The line stops at the arrow base.
 */
export function edgeGeometry(p: Pick<EdgeProps, 'source' | 'target' | 'fromSide' | 'toSide' | 'vertices' | 'lane' | 'lanes' | 'offsets' | 'zoom' | 'self' | 'name' | 'style'>): EdgeGeometry {
    const k = 1 / (p.zoom > 0 ? p.zoom : 1);
    const arrow = ARROW * k;
    const font = Math.max(LABEL, LABEL_MIN * k);
    const vertices = p.vertices ?? [];
    const curved = (p.style ?? 'curved') === 'curved';
    const self = !!p.self && !vertices.length;
    const { fromSide, toSide } = routeSides(p.source, p.target, p.fromSide, p.toSide, vertices, !!p.self);
    const n1 = NORMAL[fromSide], n2 = NORMAL[toSide];
    const vertical = (fromSide === 'top' || fromSide === 'bottom') && (toSide === 'top' || toSide === 'bottom');
    const pitch = vertical && !self ? Math.max(LANE * k, p.name.length * font * 0.65 + 24 * k) : Math.max(LANE * k, font * 2.5);
    const lane = (p.lane - (p.lanes - 1) / 2) * pitch;
    // A self edge: the ports apart on their side (both ends face the same bend, or the top). The lane raises the arch.
    const spread = p.self ? Math.min(p.source.width / 3, 60) + p.lane * 12 : 0;
    const offsetFrom = p.self ? spread : p.offsets?.from ?? lane, offsetTo = p.self ? -spread : p.offsets?.to ?? lane;
    const p1 = port(p.source, fromSide, offsetFrom), p2 = port(p.target, toSide, offsetTo);
    const e2 = { x: p2.x + n2.x * arrow * 0.8, y: p2.y + n2.y * arrow * 0.8 };
    const points = [p1, ...vertices, e2];
    const total = points.slice(1).reduce((a, q, i) => a + Math.hypot(q.x - points[i].x, q.y - points[i].y), 0);
    // The badge 30 screen px before the arrow, not before the middle of the route.
    const tailAt = Math.max(0.5, 1 - (30 * k) / (total || 1));
    if (self) {
        const h = Math.max(80, 64 * k) + p.lane * Math.max(LANE * k, font * 2.5);
        const seg: Cubic = { a: p1, c1: { x: p1.x, y: p1.y - h * 4 / 3 }, c2: { x: e2.x, y: e2.y - h * 4 / 3 }, b: e2 };
        return { path: curvePath([seg]), p1, p2, n1, n2, label: curveAt([seg], 0.5), tail: curveAt([seg], 0.88), points };
    }
    if (!curved) return { path: linePath(points), p1, p2, n1, n2, label: along(points, 0.5), tail: along(points, tailAt), points };
    // Lane separation when a small card clamps its ports (the lane fallback): push the end tangents apart. The fan-out offsets fit in the
    // side (edge-route.ts fanPitch), so the ports are the fan-out ports and the push is zero for them.
    const push = (b: Box, side: Side, at: Pt, offset: number) => side === 'top' || side === 'bottom'
        ? { x: (b.x + b.width / 2 + offset - at.x) * 4 / 3, y: 0 }
        : { x: 0, y: (b.y + b.height / 2 + offset - at.y) * 4 / 3 };
    const segments = curveSegments(points, n1, n2, push(p.source, fromSide, p1, offsetFrom), push(p.target, toSide, p2, offsetTo));
    return { path: curvePath(segments), p1, p2, n1, n2, label: curveAt(segments, 0.5), tail: curveAt(segments, tailAt), points };
}

/** Draw the edge, descriptive labels and view controls for bends and row/edge presentation. */
export function renderEdge(p: EdgeProps): VNode {
    const k = 1 / (p.zoom > 0 ? p.zoom : 1);
    const { path, p2, n2, label: at, tail } = edgeGeometry(p);
    const mid = at;
    const fontSize = Math.max(LABEL, LABEL_MIN * k);
    const controls = !(p.arrow || p.latent) && (p.selected || p.hover);
    // A vertex handle: drag to move the bend, double-click to remove it.
    const bends = !controls ? [] : (p.vertices ?? []).map((v, i) => s('circle', {
        class: { 'edge-vertex': true }, attrs: { 'data-vertex': i, cx: v.x, cy: v.y, r: VERTEX_R * k, 'stroke-width': 2 * k }
    }, [s('title', {}, ['Drag to bend the edge; double-click to remove the bend'])]));
    const label = p.parts
        ? s('text', { class: { 'edge-label': true, parts: true }, attrs: { x: at.x, y: at.y - fontSize * 0.7 }, style: { fontSize: `${fontSize}px`, strokeWidth: `${fontSize * 0.4}px` } },
            vocabularyParts(p.parts).map(x => s('tspan', { class: { muted: x.muted }, style: x.color ? { fill: x.color } : {} }, [x.text])))
        : s('text', { class: { 'edge-label': true }, attrs: { x: mid.x, y: mid.y }, style: { fontSize: `${fontSize}px`, strokeWidth: `${fontSize * 0.4}px` } }, p.nameParts
            ? [...vocabularyParts(p.nameParts), ...(p.hidden ? [{ text: ' (hidden)', muted: true }] : [])]
                .map(x => s('tspan', { class: { muted: x.muted }, style: 'color' in x && x.color ? { fill: x.color } : {} }, [x.text]))
            : [p.hidden ? `${p.name} (hidden)` : p.name]);
    const cardW = Math.max(26, 8 + (p.card?.length ?? 0) * 8) * k, cardH = 18 * k;
    // Below the line near the target end.
    const cardAt = { x: tail.x, y: tail.y + 13 * k };
    const card = p.card === undefined ? [] : [s('g', { class: { 'edge-card': true }, attrs: { transform: `translate(${cardAt.x},${cardAt.y})` } }, [
        s('title', {}, ['Cardinality']),
        s('rect', { attrs: { x: -cardW / 2, y: -cardH / 2, width: cardW, height: cardH, rx: cardH / 2 } }),
        s('text', { attrs: { x: 0, y: 0 }, style: { fontSize: `${12 * k}px` } }, [p.card])
    ])];
    const putBack = p.canPutBack ? [s('g', { class: { 'row-in': true }, attrs: { transform: `translate(${cardAt.x - cardW / 2 - 12 * k},${cardAt.y})` } }, [
        s('title', {}, ['Show as a row in all containing shapes in this view']),
        s('circle', { attrs: { r: 8 * k, 'stroke-width': 1.5 * k } }),
        s('path', { attrs: { d: ARROW_PATHS.in, transform: `scale(${k})`, 'stroke-width': 1.5 } })
    ])] : [];
    const showAsEdge = p.latent ? [s('g', { class: { 'latent-out': true }, attrs: { transform: `translate(${at.x},${at.y + 14 * k})` } }, [
        s('title', {}, ['Show as an edge in this view']),
        s('circle', { attrs: { r: 8 * k, 'stroke-width': 1.5 * k } }),
        s('path', { attrs: { d: ARROW_PATHS.out, transform: `scale(${k})`, 'stroke-width': 1.5 } })
    ])] : [];
    return s('g', {
        class: { 'catenary-edge': true, 'arrow-edge': !!p.arrow, 'latent-edge': !!p.latent, colored: !!p.color, selected: p.selected, mouseover: p.hover, 'hidden-edge': p.hidden, invalid: !!p.invalid, property: !!p.parts },
        style: vars(colorVars(p.color))
    }, [
        ...(p.details ? [s('title', {}, [p.details])] : []),
        s('path', { class: { hit: true }, attrs: { d: path } }),
        s('path', { class: { line: true }, attrs: { d: path } }),
        s('path', { class: { arrow: true }, attrs: { d: arrowHead(p2, n2, ARROW * k) } }),
        label,
        ...card,
        ...putBack,
        ...showAsEdge,
        ...bends
    ]);
}

/**
 * Center of a logical constraint circle: right of the middle of the labels of its member edges and below the lowest of them, so that
 * no label runs through it (one member: above its label). `taken`: centers of the circles drawn before it; a circle closer than 3 radii
 * to one of them moves down until it is clear.
 */
export function logicCenter(mids: Pt[], zoom: number, taken: Pt[] = []): Pt | undefined {
    if (!mids.length) return undefined;
    const k = 1 / (zoom > 0 ? zoom : 1);
    const c = mids.length === 1
        ? { x: mids[0].x, y: mids[0].y - 36 * k }
        : { x: mids.reduce((a, m) => a + m.x, 0) / mids.length + 24 * k, y: Math.max(...mids.map(m => m.y)) + 28 * k };
    for (let i = 0; i < 20 && taken.some(t => Math.hypot(t.x - c.x, t.y - c.y) < 30 * k); i++) c.y += 30 * k;
    return c;
}

/** Logical constraint: a circle at `center`, dashed lines to the label of each member edge. */
export function renderLogic(p: { mids: Pt[]; center?: Pt; operator: string; zoom: number; selected: boolean; hover: boolean }): VNode {
    const k = 1 / (p.zoom > 0 ? p.zoom : 1);
    const c = p.center;
    if (!c) return s('g', {}, []);
    return s('g', { class: { 'catenary-logic': true, selected: p.selected, mouseover: p.hover } }, [
        ...p.mids.map(m => s('line', { class: { link: true }, attrs: { x1: c.x, y1: c.y, x2: m.x, y2: m.y, 'stroke-width': 1.5 * k, 'stroke-dasharray': `${4 * k} ${3 * k}` } })),
        s('circle', { class: { ring: true }, attrs: { cx: c.x, cy: c.y, r: 10 * k, 'stroke-width': 2 * k } }),
        s('circle', { class: { dot: true }, attrs: { cx: c.x, cy: c.y, r: 3.5 * k } }),
        s('text', { attrs: { x: c.x + 13 * k, y: c.y + 13 * k }, style: { fontSize: `${13 * k}px` } }, [p.operator])
    ]);
}
