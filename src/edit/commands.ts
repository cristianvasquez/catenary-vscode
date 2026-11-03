// The view commands over the quads of the views they edit and the model facts: pure, synchronous, no graph, no store. A command edits
// the views of `views` only (decision 6); the post-steps run on the views that it changed.
import type { NamedNode } from '@rdfjs/types';
import { centered, gridPositions, isViewClip, Point, ViewClip, ViewCommand } from '../catenary/model/commands';
import { Box, boxes, DEFAULT_COLLECTION_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE } from '../catenary/model/doc';
import { iriId } from '../catenary/model/ids';
import { Classes } from '../catenary/model/metamodel';
import { layoutNewPlacements } from './clipboard';
import { nodeShapeTerm, type Facts } from './facts';
import { figureTermOf, type FiguresOf, showAsLine, syncFigures } from './figure-edits';
import * as ops from './ops';
import { elementId, elementTerm, P, rdf, relationId, termKey, V } from './terms';
import { docOfViewQuads } from './view-doc';
import type { ViewQuads } from './view-quads';

const { ok, fail } = ops;

const done = ok(undefined);

/** The views that a command edits, by view IRI. */
export type Views = Record<string, ViewQuads>;

/** ViewCommand id fields; fields that hold IRIs are not here. */
const ID_FIELDS = ['id', 'relation', 'from', 'to', 'view', 'target'];

const ID_LIST_FIELDS = ['ids', 'around'];

/** The command with `f` applied to each id field, each item of the id lists, and the id of each bound. */
function mapCommandIds(c: ViewCommand, f: (x: unknown) => unknown): ViewCommand {
    const out: Record<string, unknown> = { ...c };
    for (const k of ID_FIELDS) if (k in out && out[k] !== undefined) out[k] = f(out[k]);
    for (const k of ID_LIST_FIELDS) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(f);
    if (Array.isArray(out.bounds)) out.bounds = (out.bounds as { id: unknown }[]).map(b => ({ ...b, id: f(b.id) }));
    return out as ViewCommand;
}

/** The command with IRIs replaced by ids (as the old store): a property shape IRI by the id of its first occurrence, another IRI by its id. */
export function resolveIds(facts: Pick<Facts, 'shapes'>, c: ViewCommand): ViewCommand {
    return mapCommandIds(c, x => typeof x === 'string' && x.includes(':') ? facts.shapes.byTerm.get(termKey(rdf.namedNode(x))) ?? iriId(x) : x);
}

/** The ids, the id lists and the bounds of a command (after resolveIds). */
export function commandIds(c: ViewCommand): string[] {
    const out: string[] = [];
    mapCommandIds(c, x => { if (typeof x === 'string') out.push(x); return x; });
    return out;
}

/** Card id of an IRI in this model, if the IRI is an instance or a node shape. */
function instanceId(facts: Facts, iri: string): string | undefined {
    return facts.isInstance(iri) || nodeShapeTerm(facts, iriId(iri)) ? iriId(iri) : undefined;
}

/** A view: a view of `views` (its statements), or another view of the workspace (the facts). */
function isViewIri(views: Views, facts: Facts, iri: string): boolean {
    return views[iri] ? views[iri].match(null, P.type, V.View).length > 0 : facts.isView(iri);
}

/** The quads of the view with this id, when `views` has it. */
function viewOf(views: Views, id: string): ViewQuads | undefined {
    const v = views[elementTerm(id)?.value ?? ''];
    return v && v.match(null, P.type, V.View).length > 0 ? v : undefined;
}

/** Id of a view of `views` given by its id or its IRI. */
function viewIdOf(views: Views, view: string): string | undefined {
    if (viewOf(views, view)) return view;
    return viewOf(views, iriId(view)) ? iriId(view) : undefined;
}

/** The command with the ids of placements of cards and relations replaced by the ids of their elements (ops.elementIdOf). */
function elementIds(views: Views, facts: Facts, c: ViewCommand): ViewCommand {
    return mapCommandIds(c, x => {
        if (typeof x !== 'string') return x;
        const t = elementTerm(x), v = t && Object.values(views).find(v => v.has(t, P.type, V.Placement));
        return v ? ops.elementIdOf(v, facts, x) : x;
    });
}

const triple = (e: ViewClip['edges'][number]) => ({ s: rdf.namedNode(e.subject), p: rdf.namedNode(e.predicate), o: rdf.namedNode(e.object) });

/**
 * Add a clip to a view: the same elements, never new ones. Elements not in this model are skipped. Cards and view references
 * already in the view are skipped. Groups and notes are new boxes. The edge layouts of the clip apply to the same relations.
 * Returns the ids of the pasted boxes and of the cards already in the view.
 */
function pasteIntoView(views: Views, view: ViewQuads, facts: Facts, viewId: string, clip: ViewClip, at?: Point): ops.Result<string[]> {
    const items = clip.boxes.flatMap((b): { b: ViewClip['boxes'][number]; id: string }[] => {
        if (b.kind === 'card') return instanceId(facts, b.id) ? [{ b, id: instanceId(facts, b.id)! }] : [];
        if (b.kind === 'reference') return b.target && isViewIri(views, facts, b.target) ? [{ b, id: iriId(b.target) }] : [];
        return [{ b, id: '' }];
    });
    if (items.length === 0) return fail('The copied elements do not exist in this model.');
    const dx = at ? at.x - Math.min(...items.map(i => i.b.x)) : 0;
    const dy = at ? at.y - Math.min(...items.map(i => i.b.y)) : 0;
    // A view places an element once: a card, a member of an entity group of the view, or a reference already in the view is skipped.
    const members = new Set(boxes(docOfViewQuads(view, facts, facts.shapes.model).views[viewId], 'collection').flatMap(c => c.members));
    const inView = items.filter(({ b, id }) => (b.kind === 'card' && (!!ops.nodeOf(view, rdf.namedNode(b.id)) || members.has(id)))
        || (b.kind === 'reference' && !!ops.nodeOf(view, rdf.namedNode(b.target!))));
    if (inView.length === items.length) return alreadyInView(items.length);
    const pasted: string[] = [];
    for (const { b, id } of items.filter(i => !inView.includes(i))) {
        const place = { x: b.x + dx, y: b.y + dy };
        let r: ops.Result<string | void>;
        let element = id;
        if (b.kind === 'card') r = ops.addToView(view, facts, viewId, element, place, { width: b.width, height: b.height });
        else if (b.kind === 'group') r = ops.createGroup(view, facts, viewId, b.label, { ...place, width: b.width, height: b.height });
        else if (b.kind === 'note') r = ops.createNote(view, facts, viewId, b.text, place);
        else r = ops.createViewReference(view, facts, viewId, id, place);
        if (!r.ok) return r;
        if (b.kind !== 'card') element = r.value as string;
        const s = ops.setViewElement(view, facts, viewId, element, { width: b.width, height: b.height, color: b.color, ...(b.kind === 'card' ? { display: b.display } : {}) });
        if (!s.ok) return s;
        pasted.push(element);
    }
    for (const e of clip.edges) {
        const t = triple(e);
        if (!facts.isInstance(t.s.value) || !facts.isInstance(t.o.value) || !facts.has(t.s.value, t.p.value, t.o.value)) continue;
        if (ops.edgeOf(view, t.s, t.p, t.o)) continue;
        const { subject: _s, predicate: _p, object: _o, ...layout } = e;
        const r = ops.setEdgeLayout(view, facts, viewId, relationId(t.s, t.p, t.o), layout);
        if (!r.ok) return r;
    }
    return ok([...pasted, ...inView.map(i => i.id)]);
}

/**
 * Paste of a cut: the placements of the clip leave view `from` (cards by element, other boxes by id), then the clip is pasted into
 * view `to`. `from` equal to `to`: a re-placement. A clip gives the members of an entity group as cards: a group that loses all
 * its members leaves too (as uncollect).
 */
function moveBetweenViews(views: Views, facts: Facts, from: string, to: string, clip: ViewClip, at?: Point): ops.Result<string[]> {
    const source = viewOf(views, from)!;
    const cards = clip.boxes.flatMap(b => b.kind === 'card' && instanceId(facts, b.id) ? [instanceId(facts, b.id)!] : []);
    const collections = () => boxes(docOfViewQuads(source, facts, facts.shapes.model).views[from], 'collection');
    const affected = new Set(collections().filter(c => c.members.some(m => cards.includes(m))).map(c => c.id));
    ops.removeViewElements(source, facts, from, [...cards, ...clip.boxes.filter(b => b.kind !== 'card').map(b => b.id)]);
    ops.removeViewElements(source, facts, from, collections().filter(c => affected.has(c.id) && c.members.length === 0).map(c => c.id));
    return pasteIntoView(views, viewOf(views, to)!, facts, to, clip, at);
}

/** Add the instances that are not in the view yet: one at `at`, several in a grid around it. Returns the added ids. */
function placeAround(view: ViewQuads, facts: Facts, viewId: string, ids: string[], at: Point): string[] {
    const add = [...new Set(ids)].filter(id => !ops.nodeOf(view, ops.cardTerm(view, facts, id)!));
    const places = add.length === 1 ? [centered(at)] : gridPositions(add.length, at);
    add.forEach((id, i) => {
        const size = ops.cardSize(view, facts, id);
        // Grid positions use the data-card size. Keep each center, but use this element's dimensions.
        const at = { x: places[i].x + (DEFAULT_SIZE.width - size.width) / 2, y: places[i].y + (DEFAULT_SIZE.height - size.height) / 2 };
        ops.addToView(view, facts, viewId, id, at, size);
    });
    return add;
}

const alreadyInViewText = (n: number) => n === 1 ? 'The instance is already in this view. An element appears at most once in each view.'
    : `All ${n} instances are already in this view.`;

const alreadyInView = (n: number) => fail(alreadyInViewText(n));

/**
 * Run one command on `views` (changed in place) with the model `facts`. `figures`: the figures of a view of `views` as it is at the call.
 * `meta`: the authoring metamodel (the layout of a paste). The ids of the command can be IRIs (resolveIds). After a command that changed
 * something, on each view that it changed: placeConnectors, syncFigures, pruneArrows; after a paste or a move, the layout of the new placements.
 */
export function executeCommand(views: Views, facts: Facts, figures: FiguresOf, meta: Classes, command: ViewCommand): ops.Result<unknown> {
    const c = resolveIds(facts, command);
    // A paste or a move: the placements of the target view before the command. A move within one view re-places its cards: they count as new.
    const target = c.kind === 'pasteIntoView' ? c.view : c.kind === 'moveBetweenViews' ? viewIdOf(views, c.to) : undefined;
    const targetView = target !== undefined ? viewOf(views, target) : undefined;
    const before = targetView ? new Set(targetView.subjects(V.view, targetView.graph).map(t => elementId(t as NamedNode))) : undefined;
    if (before && c.kind === 'moveBetweenViews' && viewIdOf(views, c.from) === target) {
        for (const b of c.clip.boxes) {
            const node = b.kind === 'card' && instanceId(facts, b.id) ? ops.nodeOf(targetView!, rdf.namedNode(b.id)) : undefined;
            if (node) before.delete(elementId(node as NamedNode));
        }
    }
    const r = run(views, facts, figures, elementIds(views, facts, c));
    // One rule for every removal path: an arrow goes with its end. One rule for every placement path: relations and property edges
    // follow their ends. A no-op changes nothing.
    if (r.ok && r.changed !== false) {
        const changed = Object.values(views).filter(v => v.steps().length > 0);
        for (const v of changed) ops.placeConnectors(v, facts);
        for (const v of changed) syncFigures(v, facts, figures, c.kind !== 'showAsEdge');
        for (const v of changed) ops.pruneArrows(v, facts);
        if (before && (c.kind === 'pasteIntoView' || c.kind === 'moveBetweenViews')) layoutNewPlacements(targetView!, facts, figures, meta, target!, before, c.at, c.cardScale);
    }
    return r;
}

/** The bounds of a move in placed terms: a leaf box is placed by its list term or Pill mark. */
function boxBounds(view: ViewQuads, facts: Facts, bounds: ({ id: string } & Partial<Box>)[]): ({ id: string } & Partial<Box>)[] {
    return bounds.flatMap(b => {
        if (!b.id.endsWith('_leaf')) return [b];
        const term = figureTermOf(view, facts, b.id);
        return term ? [{ ...b, id: elementId((ops.nodeOf(view, term) ?? term) as NamedNode) }] : [];
    });
}

/** A thing of the model or of a view without a canvas figure (quad-read.ts thingHead): its label. */
function described(facts: Facts, iri: string): string | undefined {
    return facts.statementsOf([iri]).length || facts.shapesMatch(iri, null).length || facts.isView(iri) ? facts.label(iri) : undefined;
}

function run(views: Views, facts: Facts, figures: FiguresOf, c: ViewCommand): ops.Result<unknown> {
    // A command that names a view needs that view.
    if ('view' in c && c.view !== undefined && !viewOf(views, c.view)) return ops.gone('view', c.view);
    const v = 'view' in c ? viewOf(views, c.view)! : undefined!;
    switch (c.kind) {
        case 'addToView': {
            const known = c.ids.filter(id => ops.cardTerm(v, facts, id));
            if (!known.length) {
                // Find Element includes navigable things without a canvas figure.
                for (const id of c.ids) {
                    const term = elementTerm(id), label = term && described(facts, term.value);
                    if (label) return fail(`The element "${label}" has no supported canvas presentation.`);
                }
                return ops.gone('element', c.ids.join(', '));
            }
            const added = placeAround(v, facts, c.view, known, c.at);
            return added.length ? ok(added[0]) : ops.noop(alreadyInViewText(c.ids.length));
        }
        case 'showRelations': {
            const rels = c.ids.map(id => ops.relationTerms(v, facts, id)).filter(r => !!r);
            if (rels.length === 0) return ops.gone('relation', c.ids.join(', '));
            const added = placeAround(v, facts, c.view, rels.flatMap(r => [elementId(r.s), elementId(r.o)]), c.at);
            for (const id of c.ids) ops.hideEdge(v, facts, c.view, id, false);
            return ok(added[0]);
        }
        case 'showAsEdge': {
            const model = facts.shapes.model;
            if (!model.properties[c.id] && !model.constraints[c.id]) return ops.gone('property shape', c.id);
            const problem = showAsLine(v, facts, c.view, c.id, c.at);
            return problem ? fail(problem) : ok(c.id);
        }
        case 'removeFromView': {
            // A hub, a member line or its pill: the hub unit. An "in" or "one of" box: its list placement. The removal rule (syncFigures)
            // takes the lines that need what left.
            const rest: string[] = [];
            for (const id of c.ids) {
                const term = figureTermOf(v, facts, id);
                if (term && (id.startsWith('c-') || id.endsWith('_leaf') || term.value.startsWith(ops.LIST_PREFIX))) ops.dropFromView(v, facts, term);
                else if (!id.endsWith('_leaf') && !id.startsWith('c-')) rest.push(id);
            }
            ops.removeViewElements(v, facts, c.view, rest);
            return done;
        }
        case 'setBounds':
            return ops.setBounds(v, facts, c.view, boxBounds(v, facts, c.bounds), () => figures(v.graph.value));
        case 'setLayout': {
            // Every edge placement of the view, not only the edges the layout algorithm linked: a self edge and a line to an end that
            // is no layout box keep no stale bends.
            const r = ops.setBounds(v, facts, c.view, boxBounds(v, facts, c.bounds), () => figures(v.graph.value));
            return r.ok ? ops.clearEdgeLayouts(v, facts, c.view) : r;
        }
        case 'setEdgeLayout':
            return ops.setEdgeLayout(v, facts, c.view, c.relation, c.patch);
        case 'setViewElements':
            for (const id of c.ids) {
                const r = ops.setViewElement(v, facts, c.view, id, c.patch, c.expectedText);
                if (!r.ok) return r;
            }
            return done;
        case 'hideEdges':
            for (const id of c.ids) if (ops.relationTerms(v, facts, id)) ops.hideEdge(v, facts, c.view, id, c.hidden);
            return done;
        case 'createGroup': {
            const rect = (c.around?.length ? ops.boundsOf(v, facts, c.view, c.around, 50) : undefined)
                ?? c.rect ?? { x: -400, y: -250, width: 800, height: 500 };
            return ops.createGroup(v, facts, c.view, c.label, rect);
        }
        case 'createNote':
            return ops.createNote(v, facts, c.view, c.text, c.at);
        case 'createArrow':
            return ops.createArrow(v, facts, c.view, c.from, c.to);
        case 'addViewReference':
            return ops.createViewReference(v, facts, c.view, c.target, {
                x: c.at.x - DEFAULT_VIEW_REFERENCE_SIZE.width / 2, y: c.at.y - DEFAULT_VIEW_REFERENCE_SIZE.height / 2
            });
        case 'addFileReference':
            return ops.createFileReference(v, facts, c.view, c.file, {
                x: c.at.x - DEFAULT_VIEW_REFERENCE_SIZE.width / 2, y: c.at.y - DEFAULT_VIEW_REFERENCE_SIZE.height / 2
            });
        case 'collect': {
            const view = docOfViewQuads(v, facts, facts.shapes.model).views[c.view];
            const joining = boxes(view, 'collection').filter(x => c.ids.includes(x.id));
            const members = [...new Set([...c.ids.filter(id => ops.instanceTerm(v, facts, id)), ...joining.flatMap(x => x.members)])];
            const around: Box[] = [...boxes(view, 'card').filter(n => members.includes(n.element) && !joining.some(x => x.members.includes(n.element))), ...joining];
            if (around.length === 0) return fail('Select the cards to collect.');
            const x0 = Math.min(...around.map(b => b.x)), y0 = Math.min(...around.map(b => b.y));
            const x1 = Math.max(...around.map(b => b.x + b.width)), y1 = Math.max(...around.map(b => b.y + b.height));
            const { width, height } = DEFAULT_COLLECTION_SIZE;
            // The joining collections go; their members stay in the view.
            for (const x of joining) ops.removeTree(v, facts, ops.viewElementTerm(v, facts, x.id)!);
            return ops.createCollection(v, facts, c.view, members, { x: (x0 + x1 - width) / 2, y: (y0 + y1 - height) / 2, width, height });
        }
        case 'addToCollection':
            return ops.addToCollection(v, facts, c.view, c.id, c.ids);
        case 'uncollect':
            return ops.uncollect(v, facts, c.view, c.id, c.ids);
        case 'pasteIntoView': {
            if (!isViewClip(c.clip)) return fail('The clipboard does not hold view elements.');
            return pasteIntoView(views, v, facts, c.view, c.clip, c.at);
        }
        case 'moveBetweenViews': {
            if (!isViewClip(c.clip)) return fail('The clipboard does not hold view elements.');
            const from = viewIdOf(views, c.from), to = viewIdOf(views, c.to);
            if (!from) return ops.gone('view', c.from);
            if (!to) return ops.gone('view', c.to);
            return moveBetweenViews(views, facts, from, to, c.clip, c.at);
        }
        default:
            return fail(`The command kind "${(c as { kind: string }).kind}" has no implementation.`);
    }
}
