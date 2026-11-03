// Execute view-only commands against the graph; adapted from Catenary packages/rdf/src/commands.ts.
import type { NamedNode } from '@rdfjs/types';
import { centered, ViewCommand, gridPositions, isViewClip, Point, ViewClip } from '../model/commands';
import { Box, boxes, DEFAULT_COLLECTION_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE } from '../model/doc';
import { Classes } from '../model/metamodel';
import { layoutNewPlacements } from './clipboard';
import { figureTermOf, showAsLine, syncFigures } from './figure-edits';
import { ModelGraph } from './graph';
import { elementId, elementTerm, relationId } from './ids';
import * as ops from './ops';
import { thingHead } from './quad-read';
import { nodeShapeTerm, shapesIndexOf } from './shapes-read';
import { rdf } from './terms';
import { readView } from './view-read';
import { edgeOf, isView, nodeOf, V } from './views';
import { homeOf, isInstance } from './vocabulary';

const { ok, fail } = ops;

const done = ok(undefined);

/** Card id of an IRI in this model, if the IRI is an instance or a node shape. */
function instanceId(g: ModelGraph, iri: string): string | undefined {
    const t = rdf.namedNode(iri);
    return isInstance(g, t) || nodeShapeTerm(g, elementId(t)) ? elementId(t) : undefined;
}

/**
 * The command with the ids of placements of cards and relations replaced by the ids of their elements (`ops.elementIdOf`). A
 * selection on a canvas holds placements; the operations act on elements, and find the placement of an element in a view.
 */
function elementIds(g: ModelGraph, c: ViewCommand): ViewCommand {
    return mapCommandIds(c, x => typeof x === 'string' ? ops.elementIdOf(g, x) : x);
}

/** ViewCommand id fields; fields that hold IRIs are not here. */
const ID_FIELDS = ['id', 'relation', 'from', 'to', 'view', 'target'];

const ID_LIST_FIELDS = ['ids', 'around'];

/** The command with `f` applied to each id field, each item of the id lists, and the id of each bound. */
export function mapCommandIds(c: ViewCommand, f: (x: unknown) => unknown): ViewCommand {
    const out: Record<string, unknown> = { ...c };
    for (const k of ID_FIELDS) if (k in out && out[k] !== undefined) out[k] = f(out[k]);
    for (const k of ID_LIST_FIELDS) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(f);
    if (Array.isArray(out.bounds)) out.bounds = (out.bounds as { id: unknown }[]).map(b => ({ ...b, id: f(b.id) }));
    return out as ViewCommand;
}

const triple = (e: ViewClip['edges'][number]) => rdf.quad(rdf.namedNode(e.subject), rdf.namedNode(e.predicate), rdf.namedNode(e.object));

/**
 * Add a clip to a view: the same elements, never new ones. Elements not in this model are skipped. Cards and view references
 * already in the view are skipped. Groups and notes are new boxes. The edge layouts of the clip apply to the same relations.
 * Returns the ids of the pasted boxes and of the cards already in the view.
 */
function pasteIntoView(g: ModelGraph, viewId: string, clip: ViewClip, at?: Point): ops.Result<string[]> {
    // Boxes of this model: a card of an element of this model, a reference to a view of this model. `id`: its element or target view.
    const items = clip.boxes.flatMap((b): { b: ViewClip['boxes'][number]; id: string }[] => {
        if (b.kind === 'card') return instanceId(g, b.id) ? [{ b, id: instanceId(g, b.id)! }] : [];
        if (b.kind === 'reference') return b.target && isView(g, rdf.namedNode(b.target)) ? [{ b, id: elementId(rdf.namedNode(b.target)) }] : [];
        return [{ b, id: '' }];
    });
    if (items.length === 0) return fail('The copied elements do not exist in this model.');
    const dx = at ? at.x - Math.min(...items.map(i => i.b.x)) : 0;
    const dy = at ? at.y - Math.min(...items.map(i => i.b.y)) : 0;
    const view = ops.viewTerm(g, viewId)!;
    // A view places an element once: a card, a member of an entity group of the view, or a reference already in the view is skipped.
    const members = new Set(boxes(readView(g, viewId).views[viewId], 'collection').flatMap(c => c.members));
    const inView = items.filter(({ b, id }) => (b.kind === 'card' && (!!nodeOf(g, view, rdf.namedNode(b.id)) || members.has(id)))
        || (b.kind === 'reference' && !!nodeOf(g, view, rdf.namedNode(b.target!))));
    if (inView.length === items.length) return alreadyInView(items.length);
    const pasted: string[] = [];
    for (const { b, id } of items.filter(i => !inView.includes(i))) {
        const place = { x: b.x + dx, y: b.y + dy };
        let r: ops.Result<string | void>;
        let element = id;
        if (b.kind === 'card') r = ops.addToView(g, viewId, element, place, { width: b.width, height: b.height });
        else if (b.kind === 'group') r = ops.createGroup(g, viewId, b.label, { ...place, width: b.width, height: b.height });
        else if (b.kind === 'note') r = ops.createNote(g, viewId, b.text, place);
        else r = ops.createViewReference(g, viewId, id, place);
        if (!r.ok) return r;
        if (b.kind !== 'card') element = r.value as string;
        const s = ops.setViewElement(g, viewId, element, { width: b.width, height: b.height, color: b.color, ...(b.kind === 'card' ? { display: b.display } : {}) });
        if (!s.ok) return s;
        pasted.push(element);
    }
    for (const e of clip.edges) {
        const t = triple(e);
        if (!isInstance(g, t.subject) || !isInstance(g, t.object) || !g.has(rdf.quad(t.subject, t.predicate, t.object, homeOf(g, t.subject)))) continue;
        if (edgeOf(g, view, t.subject, t.predicate, t.object)) continue;
        const { subject: _s, predicate: _p, object: _o, ...layout } = e;
        const r = ops.setEdgeLayout(g, viewId, relationId(t.subject as NamedNode, t.predicate as NamedNode, t.object as NamedNode), layout);
        if (!r.ok) return r;
    }
    return ok([...pasted, ...inView.map(i => i.id)]);
}

/** Id of a view given by its id or its IRI; undefined if it is not a view of this model. */
function viewIdOf(g: ModelGraph, view: string): string | undefined {
    if (ops.viewTerm(g, view)) return view;
    const t = rdf.namedNode(view);
    return isView(g, t) ? elementId(t) : undefined;
}

/**
 * Paste of a cut: the placements of the clip leave view `from` (cards by element, other boxes by id), then the clip is pasted into
 * view `to`. `from` equal to `to`: a re-placement. A clip gives the members of an entity group as cards: a group that loses all
 * its members leaves too (as uncollect).
 */
function moveBetweenViews(g: ModelGraph, from: string, to: string, clip: ViewClip, at?: Point): ops.Result<string[]> {
    const cards = clip.boxes.flatMap(b => b.kind === 'card' && instanceId(g, b.id) ? [instanceId(g, b.id)!] : []);
    const collections = () => boxes(readView(g, from).views[from], 'collection');
    const affected = new Set(collections().filter(c => c.members.some(m => cards.includes(m))).map(c => c.id));
    ops.removeViewElements(g, from, [...cards, ...clip.boxes.filter(b => b.kind !== 'card').map(b => b.id)]);
    ops.removeViewElements(g, from, collections().filter(c => affected.has(c.id) && c.members.length === 0).map(c => c.id));
    return pasteIntoView(g, to, clip, at);
}

/** Add the instances that are not in the view yet: one at `at`, several in a grid around it. Returns the added ids. */
function placeAround(g: ModelGraph, viewId: string, ids: string[], at: Point): string[] {
    const view = ops.viewTerm(g, viewId)!;
    const add = [...new Set(ids)].filter(id => !nodeOf(g, view, ops.cardTerm(g, id)!));
    const places = add.length === 1 ? [centered(at)] : gridPositions(add.length, at);
    add.forEach((id, i) => {
        const size = ops.cardSize(g, id);
        // Grid positions use the data-card size. Keep each center, but use this element's dimensions.
        const at = { x: places[i].x + (DEFAULT_SIZE.width - size.width) / 2, y: places[i].y + (DEFAULT_SIZE.height - size.height) / 2 };
        ops.addToView(g, viewId, id, at, size);
    });
    return add;
}

const alreadyInViewText = (n: number) => n === 1 ? 'The instance is already in this view. An element appears at most once in each view.'
    : `All ${n} instances are already in this view.`;

const alreadyInView = (n: number) => fail(alreadyInViewText(n));

export function executeCommand(g: ModelGraph, meta: Classes, c: ViewCommand): ops.Result<unknown> {
    // A paste or a move: the placements of the target view before the command. A move within one view re-places its cards: they
    // count as new.
    const target = c.kind === 'pasteIntoView' ? c.view : c.kind === 'moveBetweenViews' ? viewIdOf(g, c.to) : undefined;
    const targetView = target !== undefined ? ops.viewTerm(g, target) : undefined;
    const before = targetView ? new Set(g.subjects(V.view, targetView, null).map(t => elementId(t as NamedNode))) : undefined;
    if (before && c.kind === 'moveBetweenViews' && viewIdOf(g, c.from) === target) {
        for (const b of c.clip.boxes) {
            const node = b.kind === 'card' && instanceId(g, b.id) ? nodeOf(g, targetView!, rdf.namedNode(b.id)) : undefined;
            if (node) before.delete(elementId(node as NamedNode));
        }
    }
    const r = run(g, elementIds(g, c));
    // One rule for every removal path: an arrow goes with its end. One rule for every placement path: relations and property edges
    // follow their ends. A no-op changes nothing.
    if (r.ok && r.changed !== false) {
        ops.placeConnectors(g);
        syncFigures(g, c.kind !== 'showAsEdge');
        ops.pruneArrows(g);
        if (before && (c.kind === 'pasteIntoView' || c.kind === 'moveBetweenViews')) {
            layoutNewPlacements(g, meta, target!, before, c.at, c.cardScale);

        }
    }
    return r;
}

/**
 * The bounds of a move in placed terms: a leaf box is placed by its list term or Pill mark.
 */
function boxBounds(g: ModelGraph, view: NamedNode, bounds: ({ id: string } & Partial<Box>)[]): ({ id: string } & Partial<Box>)[] {
    return bounds.flatMap(b => {
        if (!b.id.endsWith('_leaf')) return [b];
        const term = figureTermOf(g, b.id, view);
        return term ? [{ ...b, id: elementId((nodeOf(g, view, term) ?? term) as NamedNode) }] : [];
    });
}

function run(g: ModelGraph, c: ViewCommand): ops.Result<unknown> {
    // A command that names a view needs that view.
    if ('view' in c && c.view !== undefined && !ops.viewTerm(g, c.view)) return ops.gone('view', c.view);
    switch (c.kind) {
        case 'addToView': {
            const known = c.ids.filter(id => ops.cardTerm(g, id));
            if (!known.length) {
                // Find Element includes navigable things without a canvas figure.
                for (const id of c.ids) {
                    const term = elementTerm(id);
                    const head = term?.termType === 'NamedNode' && thingHead(g, term);
                    if (head) return fail(`The element "${head.label}" has no supported canvas presentation.`);
                }
                return ops.gone('element', c.ids.join(', '));
            }
            const added = placeAround(g, c.view, known, c.at);
            return added.length ? ok(added[0]) : ops.noop(alreadyInViewText(c.ids.length));
        }
        case 'showRelations': {
            const rels = c.ids.map(id => ops.relationTerms(g, id)).filter(r => !!r);
            if (rels.length === 0) return ops.gone('relation', c.ids.join(', '));
            const added = placeAround(g, c.view, rels.flatMap(r => [elementId(r.s), elementId(r.o)]), c.at);
            for (const id of c.ids) ops.hideEdge(g, c.view, id, false);
            return ok(added[0]);
        }
        case 'showAsEdge': {
            const model = shapesIndexOf(g).model;
            if (!model.properties[c.id] && !model.constraints[c.id]) return ops.gone('property shape', c.id);
            const problem = showAsLine(g, c.view, c.id, c.at);
            return problem ? fail(problem) : ok(c.id);
        }
        case 'removeFromView': {
            // A hub, a member line or its pill: the hub unit. An "in" or "one of" box: its list placement. The removal rule (syncFigures)
            // takes the lines that need what left.
            const view = ops.viewTerm(g, c.view)!;
            const rest: string[] = [];
            for (const id of c.ids) {
                const term = figureTermOf(g, id, view);
                if (term && (id.startsWith('c-') || id.endsWith('_leaf') || term.value.startsWith(ops.LIST_PREFIX))) ops.dropFromView(g, view, term);
                else if (!id.endsWith('_leaf') && !id.startsWith('c-')) rest.push(id);
            }
            ops.removeViewElements(g, c.view, rest);
            return done;
        }
        case 'setBounds':
            return ops.setBounds(g, c.view, boxBounds(g, ops.viewTerm(g, c.view)!, c.bounds));
        case 'setLayout': {
            // Every edge placement of the view, not only the edges the layout algorithm linked: a self edge and a line to an end that
            // is no layout box keep no stale bends.
            const r = ops.setBounds(g, c.view, boxBounds(g, ops.viewTerm(g, c.view)!, c.bounds));
            return r.ok ? ops.clearEdgeLayouts(g, c.view) : r;
        }
        case 'setEdgeLayout':
            return ops.setEdgeLayout(g, c.view, c.relation, c.patch);
        case 'setViewElements':
            for (const id of c.ids) {
                const r = ops.setViewElement(g, c.view, id, c.patch, c.expectedText);
                if (!r.ok) return r;
            }
            return done;
        case 'hideEdges':
            for (const id of c.ids) if (ops.relationTerms(g, id)) ops.hideEdge(g, c.view, id, c.hidden);
            return done;
        case 'createGroup': {
            const rect = (c.around?.length ? ops.boundsOf(g, c.view, c.around, 50) : undefined)
                ?? c.rect ?? { x: -400, y: -250, width: 800, height: 500 };
            return ops.createGroup(g, c.view, c.label, rect);
        }
        case 'createNote':
            return ops.createNote(g, c.view, c.text, c.at);
        case 'createArrow':
            return ops.createArrow(g, c.view, c.from, c.to);
        case 'addViewReference':
            return ops.createViewReference(g, c.view, c.target, {
                x: c.at.x - DEFAULT_VIEW_REFERENCE_SIZE.width / 2, y: c.at.y - DEFAULT_VIEW_REFERENCE_SIZE.height / 2
            });
        case 'addFileReference':
            return ops.createFileReference(g, c.view, c.file, {
                x: c.at.x - DEFAULT_VIEW_REFERENCE_SIZE.width / 2, y: c.at.y - DEFAULT_VIEW_REFERENCE_SIZE.height / 2
            });
        case 'collect': {
            const view = readView(g, c.view).views[c.view];
            const joining = boxes(view, 'collection').filter(x => c.ids.includes(x.id));
            const members = [...new Set([...c.ids.filter(id => ops.instanceTerm(g, id)), ...joining.flatMap(x => x.members)])];
            const around: Box[] = [...boxes(view, 'card').filter(n => members.includes(n.element) && !joining.some(x => x.members.includes(n.element))), ...joining];
            if (around.length === 0) return fail('Select the cards to collect.');
            const x0 = Math.min(...around.map(b => b.x)), y0 = Math.min(...around.map(b => b.y));
            const x1 = Math.max(...around.map(b => b.x + b.width)), y1 = Math.max(...around.map(b => b.y + b.height));
            const { width, height } = DEFAULT_COLLECTION_SIZE;
            // The joining collections go; their members stay in the view.
            const v = ops.viewTerm(g, c.view)!;
            for (const x of joining) ops.removeTree(g, ops.viewElementTerm(g, v, x.id)!, v);
            return ops.createCollection(g, c.view, members, { x: (x0 + x1 - width) / 2, y: (y0 + y1 - height) / 2, width, height });
        }
        case 'addToCollection':
            return ops.addToCollection(g, c.view, c.id, c.ids);
        case 'uncollect':
            return ops.uncollect(g, c.view, c.id, c.ids);
        case 'pasteIntoView': {
            if (!isViewClip(c.clip)) return fail('The clipboard does not hold view elements.');
            return pasteIntoView(g, c.view, c.clip, c.at);
        }
        case 'moveBetweenViews': {
            if (!isViewClip(c.clip)) return fail('The clipboard does not hold view elements.');
            const from = viewIdOf(g, c.from), to = viewIdOf(g, c.to);
            if (!from) return ops.gone('view', c.from);
            if (!to) return ops.gone('view', c.to);
            return moveBetweenViews(g, from, to, c.clip, c.at);
        }
        default:
            return fail(`The command kind "${(c as { kind: string }).kind}" has no implementation.`);
    }
}
