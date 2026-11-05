// Canvas gestures, view edits, navigation and file drops; adapted from Catenary modeler/src/browser/diagram/canvas.ts.
// Model data is read-only; commands change view files or open workspace elements in the editor.

import { DeleteElementOperation, GEdge, IDiagramStartup, SelectAction, SetViewportAction, isViewport } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import type { Point, Rect } from '../catenary/model/commands';
import { DEFAULT_SIZE } from '../catenary/model/doc';
import { LATENT_SUFFIX, LEAF_SUFFIX, TYPES, ownerOfLabel } from '../catenary/model/diagram-schema';
import { DROP_FILES_EVENT, OPEN_IN_EVENT } from './messages';
import type { GestureInfo, TargetList, ViewGesture } from '../catenary/model/view-ui';
import { ModelActions } from './actions';
import { COLOR_NAMES, COLOR_ORDER, colorValue } from './card-chrome';
import { nearestSegment } from './edge-route';
import { inlineInput } from './inline-input';
import { ModelFrontend } from './model-client';
import { editCanvasName } from './name-edit';
import { NoteEditor } from './note-editor';
import { CanvasWidget, ViewEditors, viewIdOf } from './view-editors';

/** Elements that an arrow can connect. */
const BOXES = '.catenary-card, .catenary-note, .catenary-group, .catenary-view-reference, .catenary-member-box, .catenary-leaf';
/** Boxes that Shift+click adds to or removes from the selection. */
const TOGGLED = '.catenary-card, .catenary-group, .catenary-member-box';
/** Elements that a connect gesture dims when they are not its targets. */
const CONNECTABLE = `${BOXES}, .catenary-edge, .catenary-logic, .shape-row, .member-row`;
/** Screen px of movement that make a bend gesture an edit; a release under it sends no command. */
const BEND_MOVE_PX = 2;

/**
 * A connect gesture (CanvasInteractions.connectDrag): its targets and what a release does. The data of the gesture comes from the
 * backend when it starts (`info`, RPC `viewGesture`); the checks during the drag are synchronous on it.
 */
interface ConnectGesture {
    /** The elements that can be targets. */
    selector: string;
    /** The answer of the backend for this gesture. */
    info: Promise<GestureInfo>;
    /** Why an element of `selector` is not a target; undefined: it is one. Decides the dimming, the drop and the message on release. */
    problem: (el: Element, info: GestureInfo) => string | undefined;
    /** The element the drag starts from: not dimmed, no message on release on it (or on its container). */
    source?: Element | null;
    /** Start of the line (client coordinates). Default: the point of `start`. */
    from?: { x: number; y: number };
    /** Release on a target. */
    drop: (e: MouseEvent, target: Element, info: GestureInfo) => void;
    /** Release less than 8 px from `from`, not on a target. */
    click?: (e: MouseEvent, info: GestureInfo) => void;
    /** Release on empty canvas. */
    empty?: (e: MouseEvent, info: GestureInfo) => void;
}

/** A press on a row button of a container. `at`: beside the row, right of the drawn container (model point). */
interface RowPress { w: CanvasWidget; view: string; id: string; member: string; shown: string; button: Element; at: Point }
/** A container kind: its box, its row button selectors and their effects (CanvasInteractions.containers). `add`: only the view edit ("+ member" of a collection). */
interface ContainerKind {
    box: string; takeOut: string; remove?: string; add?: string;
    onTakeOut: (p: RowPress) => void; onRemove?: (p: RowPress) => void; onAdd?: (p: RowPress) => void;
}

/** Why a candidate of a gesture is not a target (GestureInfo); undefined: it is one. */
function problemIn(info: GestureInfo, list: TargetList, id: string): string | undefined {
    const p = info.problems[list]?.[id];
    return p === '' ? undefined : p ?? 'The view editor has no answer from the backend for this gesture.';
}

/**
 * Give the focus to a view editor after a press that the canvas handles itself (preventDefault: no native focus). The base div has no
 * tabindex, so it cannot take the focus; the svg can.
 */
function focusCanvas(w: CanvasWidget): void {
    document.getElementById(w.viewerOptions.baseDiv)?.querySelector<SVGSVGElement>('svg.sprotty-graph')?.focus();
}

@injectable()
export class CanvasInteractions implements IDiagramStartup {
    @inject(CanvasWidget) protected readonly widget: CanvasWidget;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(NoteEditor) protected readonly noteEditor: NoteEditor;
    protected readonly installed = new WeakSet<CanvasWidget>();
    /** The last bend gesture of each edge (by relation): a refusal restores the route only for the gesture that drew it. */
    protected readonly bendGestures = new Map<string, number>();

    /** VS Code glue: the canvas of this webview, after its first model (Theia: each view editor widget the shell adds). */
    postModelInitialization(): void {
        this.install(this.widget);
    }

    protected install(w: CanvasWidget): void {
        if (this.installed.has(w)) return;
        this.installed.add(w);
        const host = w.node;
        const idOf = (el: Element | null, selector: string) => this.idOf(w, el, selector);

        // Capture phase: runs before the GLSP mouse tools, so that a drag on the handle does not move the card.
        host.addEventListener('mousedown', e => {
            const target = e.target as Element;
            if (e.button !== 0 || target.closest?.('.catenary-name-input, .catenary-embedded-input')) return;
            if (e.detail === 2) {
                const note = idOf(target, '.catenary-note');
                if (note) {
                    e.preventDefault();
                    e.stopPropagation();
                    void this.noteEditor.open(note);
                    return;
                }
            }
            if (this.containerPress(w, target, e) || this.shapesPress(w, target, e)) return;
            const badged = target.closest?.('.catenary-card > .badge') ? idOf(target, '.catenary-card') : undefined;
            if (badged) {
                // The violation badge: show the problem, no drag and no selection change.
                e.preventDefault();
                e.stopPropagation();
                this.showProblem(badged);
                return;
            }
            const halo = target.closest?.('.halo-action');
            if (halo) {
                const box = halo.closest('.catenary-halo')?.getAttribute('data-element');
                if (box === null || box === undefined) return;
                const id = box && this.editors.elementOf(w, box);
                e.preventDefault();
                e.stopPropagation();
                this.haloAction(w, id, halo, e);
            } else if (target.closest?.('.edge-vertex')) {
                const relation = idOf(target, '.catenary-edge');
                const index = Number(target.closest('.edge-vertex')!.getAttribute('data-vertex'));
                if (!relation || !Number.isInteger(index) || e.detail > 1) return;
                e.preventDefault();
                e.stopPropagation();
                this.bendDrag(w, relation, index, false, e);
            } else if (e.shiftKey && !target.closest?.('.catenary-resize-handle, .catenary-resize-grip') && idOf(target, TOGGLED)) {
                // GLSP adds with Ctrl only; with a selection, its Shift+click replaces the selection.
                e.preventDefault();
                e.stopPropagation();
                this.toggle(w, idOf(target, TOGGLED)!);
            } else if ((target.classList?.contains('hit') || target.classList?.contains('line')) && target.parentElement?.classList.contains('catenary-edge')) {
                // A click selects the edge; a drag adds a bend that follows the pointer. GLSP does not get the press: it would pan the canvas.
                const relation = idOf(target, '.catenary-edge');
                if (!relation) return;
                e.preventDefault();
                e.stopPropagation();
                // An arrow, a bundle or an alternative has no bends: a press only selects it.
                const bendable = !['arrow-edge', 'catenary-bundle', 'catenary-alternative', 'latent-edge'].some(c => target.parentElement!.classList.contains(c));
                this.lineDrag(w, relation, e, bendable);
            }
        }, true);

        // The halo is in the root layer (CatenaryGraphView): for GLSP, a mouse up on it is a click on empty canvas, which clears the selection.
        for (const type of ['mouseup', 'click', 'dblclick'] as const) {
            host.addEventListener(type, e => { if ((e.target as Element).closest?.('.catenary-halo')) e.stopPropagation(); }, true);
        }

        host.addEventListener('dblclick', e => {
            const t = e.target as Element;
            if (t.closest?.('.catenary-name-input, .catenary-embedded-input')) return;
            const vertex = t.closest?.('.edge-vertex');
            if (vertex) {
                const relation = idOf(t, '.catenary-edge'), index = Number(vertex.getAttribute('data-vertex'));
                if (!relation || !Number.isInteger(index)) return;
                e.preventDefault();
                e.stopPropagation();
                const vertices = this.vertices(w, relation).filter((_, i) => i !== index);
                void this.model.execute({ kind: 'setEdgeLayout', view: viewIdOf(w), relation, patch: { vertices } });
                return;
            }
            // Only the label of a group: the name of a card is a model label.
            const name = t.closest?.('.group-label');
            const named = name ? idOf(t, '.catenary-group') : undefined;
            if (named && editCanvasName(w, named, viewIdOf(w), this.editors, this.model)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const reference = idOf(t, '.catenary-view-reference');
            if (reference) {
                e.preventDefault();
                e.stopPropagation();
                return this.openIn(w, reference);
            }
            const id = idOf(t, '.catenary-note');
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            void this.noteEditor.open(id);
        }, true);

        // Files dragged from the explorer (text/uri-list): a view file becomes a view reference, another file a file reference (host).
        const accept = (e: DragEvent) => {
            if (!e.dataTransfer?.types.includes('text/uri-list')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
        };
        host.addEventListener('dragenter', accept, true);
        host.addEventListener('dragover', accept, true);
        host.addEventListener('drop', e => {
            const uris = (e.dataTransfer?.getData('text/uri-list') ?? '').split(/\r?\n/).filter(u => u && !u.startsWith('#'));
            if (!uris.length) return;
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new CustomEvent(DROP_FILES_EVENT, { detail: { uris, at: this.editors.toModel(w, e.clientX, e.clientY) } }));
        }, true);
    }

    /** Open in the editor what the element `id` shows: the view or file of a reference, else the statements of the model element. */
    protected openIn(w: CanvasWidget, id: string): void {
        const shown = this.shown(w, id) as { type?: string; targetViewId?: string; targetFile?: string } | undefined;
        const detail = shown?.type === TYPES.VIEW_REFERENCE ? (shown.targetFile ? { file: shown.targetFile } : { view: shown.targetViewId }) : { element: id };
        document.dispatchEvent(new CustomEvent(OPEN_IN_EVENT, { detail }));
    }

    /** Show the problem of the element `id` in the host (one problem: its location; several: a picker). Halo menu and violation badge. */
    protected showProblem(id: string): void {
        document.dispatchEvent(new CustomEvent(OPEN_IN_EVENT, { detail: { problem: id } }));
    }

    /** The "…" of the halo: the view actions of the selection in the popup picker. */
    protected menu(w: CanvasWidget, id: string, button: Element, selected: string[]): void {
        const b = button.getBoundingClientRect(), view = viewIdOf(w), anchor = { x: b.left, y: b.bottom + 6 };
        const shown = id ? this.shown(w, id) : undefined;
        const openable = shown && ([TYPES.CARD, TYPES.SHAPE, TYPES.VALUESET, TYPES.VIEW_REFERENCE] as string[]).includes(shown.type as string);
        const cards = selected.map(element => this.shown(w, element)).filter(element => element?.display !== undefined);
        void this.actions.pick('Actions', [
            { label: 'Color', swatches: ['', ...COLOR_ORDER].map(color => ({
                label: color ? COLOR_NAMES[color] : 'default', color: colorValue(color) ?? '', current: shown?.color === color,
                run: () => this.model.execute({ kind: 'setViewElements', view, ids: selected, patch: { color } })
            })) },
            ...(cards.length ? ([['simple', 'Simple'], ['shaped', 'Shaped rows'], ['detailed', 'All rows']] as const).map(([display, label]) => ({
                label: `${cards.every(card => card?.display === display) ? '✓ ' : ''}${label}`,
                run: () => this.model.execute({ kind: 'setViewElements', view, ids: selected, patch: { display } })
            })) : []),
            { type: 'separator', label: '' },
            { label: 'Remove from view', description: 'Del', run: () => id.endsWith(LEAF_SUFFIX) ? this.actions.removeFromView(view, id)
                : w.actionDispatcher.dispatch(DeleteElementOperation.create(this.selectedIn(w))) },
            ...(Number(shown?.violations) > 0 ? [{ label: Number(shown?.violations) > 1 ? 'Show the problems' : 'Show the problem',
                run: () => this.showProblem(id) }] : []),
            ...(openable ? [{ label: 'Open in the editor', run: () => this.openIn(w, id) }] : []),
            ...(selected.length > 1 ? [{ label: 'Collect into one box', run: () => this.actions.collect(view, selected) }] : []),
            ...(shown?.type === TYPES.COLLECTION ? [{ label: 'Expand: show the cards again', run: () => this.actions.uncollect(view, [id]) }] : []),
            { label: 'Layout…', run: () => this.actions.layoutView(anchor) }
        ], anchor);
    }

    /** The DOM node of an element (by element id: its card or edge, by the id of its placement) or of a box (by its id). */
    protected nodeOf(w: CanvasWidget, id: string): HTMLElement | null {
        return document.getElementById(`${w.viewerOptions.baseDiv}_${this.editors.placementOf(w, id)}`);
    }

    /**
     * Element id of the closest `selector` ancestor of `el` in this view editor. The diagram id of a card or a placed edge is the
     * id of its placement: it gives its element (the diagram graph, ViewEditors.elementOf); other ids stay (a mark: its placement).
     */
    protected idOf(w: CanvasWidget, el: Element | null, selector: string): string | undefined {
        const baseDiv = w.viewerOptions.baseDiv;
        const g = el?.closest(selector);
        const id = g?.id?.startsWith(baseDiv + '_') ? g.id.slice(baseDiv.length + 1) : undefined;
        return id === undefined ? undefined : this.editors.elementOf(w, id);
    }

    /**
     * Press that becomes a drag after `threshold` px of movement once `ready` is true: `drag` runs with that move event. Else, on
     * release: `release`, with `moved` true when the pointer moved `threshold` px (but `ready` stayed false).
     */
    protected pressDrag(start: MouseEvent, drag: (e: MouseEvent) => void, release: (e: MouseEvent, moved: boolean) => void,
        ready: (e: MouseEvent) => boolean = () => true, threshold = 6): void {
        let moved = false;
        const move = (e: MouseEvent) => {
            if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < threshold) return;
            moved = true;
            if (!ready(e)) return;
            stop();
            drag(e);
        };
        const up = (e: MouseEvent) => {
            stop();
            release(e, moved);
        };
        const stop = () => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
    }

    /**
     * Connect gesture `g`: the elements of `g.selector` without a problem are the targets
     * (dragLine). Release on a target: `g.drop`. Else: `g.click` near the start; on a dimmed element (not the source): the reason, as a
     * message; on empty canvas: `g.empty`; outside the view: nothing.
     */
    protected connectDrag(w: CanvasWidget, start: MouseEvent, g: ConnectGesture): void {
        const from = g.from ?? { x: start.clientX, y: start.clientY };
        const info = g.info.catch((): GestureInfo => ({ problems: {} }));
        const targets = info.then(i => [...w.node.querySelectorAll(g.selector)].filter(el => !g.problem(el, i)));
        this.dragLine(w, from, start, async (e, target) => {
            const i = await info;
            if (target) return g.drop(e, target, i);
            if (g.click && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 8) return g.click(e, i);
            const under = document.elementFromPoint(e.clientX, e.clientY);
            if (!under || !w.node.contains(under)) return;
            if (!under.closest(CONNECTABLE)) return g.empty?.(e, i);
            const el = under.closest(g.selector);
            const reason = el && !(g.source && el.contains(g.source)) ? g.problem(el, i) : undefined;
            if (reason) this.actions.warn(reason);
        }, targets, g.source);
    }

    /** The answer of the backend for a gesture of this view editor (RPC `viewGesture`): the problems of its candidates, the facts of its element. */
    protected gesture(w: CanvasWidget, g: ViewGesture): Promise<GestureInfo> {
        return this.model.service.viewGesture(viewIdOf(w), g).catch((): GestureInfo => ({ problems: {} }));
    }

    /** The ids of the elements of `selector` in this view editor, by `id`, once each: the candidates of a gesture. */
    protected candidates(w: CanvasWidget, selector: string, id: (el: Element) => string): string[] {
        return [...new Set([...w.node.querySelectorAll(selector)].map(id))];
    }

    /** Mouse down on the edge line: after 6 px of movement, a new bend at the press point follows the pointer (bendDrag); else select the edge. */
    protected lineDrag(w: CanvasWidget, relation: string, start: MouseEvent, bendable = true): void {
        this.pressDrag(start, e => {
            const edge = this.edgeOf(w, relation);
            if (!edge) return;
            const source = edge.source as { bounds?: Rect } | undefined, target = edge.target as { bounds?: Rect } | undefined;
            const at = this.editors.toModel(w, start.clientX, start.clientY);
            // The new bend goes on the segment of the polyline (ports and bends) nearest to the press point.
            const center = (b?: Rect) => b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : at;
            const index = nearestSegment([center(source?.bounds), ...(edge.vertices ?? []), center(target?.bounds)], at);
            this.bendDrag(w, relation, index, true, e, at);
        }, e => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) this.toggle(w, relation);
            else {
                w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: [this.editors.placementOf(w, relation)], deselectedElementsIDs: true }));
                focusCanvas(w);
            }
        }, () => bendable);
    }

    /** The edge element of the client model of a relation or a property shape, with its bends. */
    protected edgeOf(w: CanvasWidget, relation: string): (GEdge & { vertices?: Point[] }) | undefined {
        let root;
        try { root = w.editorContext.modelRoot; } catch { return undefined; }
        const e = root.index.getById(this.editors.placementOf(w, relation));
        return e instanceof GEdge ? e : undefined;
    }

    /** The bends of an edge, as the client model draws them. */
    protected vertices(w: CanvasWidget, relation: string): Point[] {
        return [...(this.edgeOf(w, relation)?.vertices ?? [])];
    }

    /**
     * Drag of a bend of an edge: the bend `index` follows the pointer; `insert`: a new bend at `index` (at `at`). The client
     * model draws the move; the release sends one setEdgeLayout. A release without movement (under 2 px) sends nothing and redraws the
     * route as it was: a click on a handle keeps the saved route, and a double-click produces only the removal. An existing bend keeps its
     * offset to the pointer. A refused command (a locked view file) restores the drawn route, unless the model root was replaced or a
     * newer bend gesture started on the edge.
     */
    protected bendDrag(w: CanvasWidget, relation: string, index: number, insert: boolean, start: MouseEvent, at?: Point): void {
        const edge = this.edgeOf(w, relation);
        if (!edge) return;
        const seq = (this.bendGestures.get(relation) ?? 0) + 1;
        this.bendGestures.set(relation, seq);
        const before = [...(edge.vertices ?? [])];
        const vertices = [...before];
        const press = this.editors.toModel(w, start.clientX, start.clientY);
        if (insert) vertices.splice(index, 0, at ?? press);
        // An existing bend keeps its offset to the pointer at the press: it does not jump to the pointer on the first move. A new bend
        // is at the press point and follows the pointer.
        const offset = insert ? { x: 0, y: 0 } : { x: vertices[index].x - press.x, y: vertices[index].y - press.y };
        const origin = { x: start.clientX, y: start.clientY };
        let frame = 0;
        const draw = (v = vertices) => {
            frame = 0;
            edge.vertices = v;
            let root;
            try { root = w.editorContext.modelRoot; } catch { return; }
            if (isViewport(root)) w.actionDispatcher.dispatch(SetViewportAction.create(root.id, { scroll: root.scroll, zoom: root.zoom }, { animate: false }));
        };
        const pointer = (e: MouseEvent) => {
            const p = this.editors.toModel(w, e.clientX, e.clientY);
            return { x: p.x + offset.x, y: p.y + offset.y };
        };
        const move = (e: MouseEvent) => {
            vertices[index] = pointer(e);
            if (!frame) frame = requestAnimationFrame(() => draw());
        };
        const up = (e: MouseEvent) => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
            document.body.classList.remove('catenary-grabbing');
            if (frame) cancelAnimationFrame(frame);
            const moved = Math.hypot(e.clientX - origin.x, e.clientY - origin.y) >= BEND_MOVE_PX;
            if (!moved) { draw(before); return; }
            vertices[index] = pointer(e);
            draw();
            void this.model.execute({ kind: 'setEdgeLayout', view: viewIdOf(w), relation, patch: { vertices } }).then(r => {
                if (r.ok) return;
                // The server kept the saved route: the client model goes back to it, if this gesture still owns the drawn edge.
                if (this.bendGestures.get(relation) !== seq || this.edgeOf(w, relation) !== edge) return;
                draw(before);
            });
        };
        document.body.classList.add('catenary-grabbing');
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
        draw();
    }

    /** The part of the selection that this view editor shows. VS Code glue: one canvas, its GLSP selection (no SelectionModel). */
    protected selectedIn(w: CanvasWidget): string[] {
        return w.editorContext.selectedElements.map(e => e.id);
    }

    /** Add an element to the selection, or remove it if it is selected. The view editor gets the focus: the selection goes to the panels. */
    protected toggle(w: CanvasWidget, element: string): void {
        const id = this.editors.placementOf(w, element);   // the diagram id
        const selected = this.selectedIn(w).includes(id);
        w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: selected ? [] : [id], deselectedElementsIDs: selected ? [id] : [] }));
        focusCanvas(w);
    }

    /** A halo button of the only selected element `id` ('' for several). The commands act on the selection. */
    protected haloAction(w: CanvasWidget, id: string, button: Element, e: MouseEvent): void {
        const b = button.getBoundingClientRect(), view = viewIdOf(w);
        const selected = () => [...new Set(this.selectedIn(w).map(s => this.editors.elementOf(w, ownerOfLabel(s))))];
        switch (button.getAttribute('data-action')) {
            // A "one of" box is no element of its own: its list placement leaves, with the line to it.
            // VS Code glue: Remove from View of the selection is the GLSP delete operation (DeleteHandler), as Del.
            case 'remove': return id.endsWith(LEAF_SUFFIX) ? void this.actions.removeFromView(view, id)
                : void w.actionDispatcher.dispatch(DeleteElementOperation.create(this.selectedIn(w)));
            case 'collect': return void this.actions.collect(view, selected());
            case 'uncollect': return void this.actions.uncollect(view, selected());
            case 'arrow': return this.arrowDrag(w, id, e);
            case 'openIn': return this.openIn(w, id);
            case 'menu': return this.menu(w, id, button, selected());
            case 'expandIn': {
                const shape = this.isNodeShape(w, id), anchor = { x: b.left - 8, y: b.top };
                return void this.gesture(w, { kind: 'element', id }).then(i => {
                    const at = this.beside(w, i.box, button, 'in');
                    return shape ? this.actions.expandShape(id, viewIdOf(w), at, anchor) : this.actions.expand('in', id, viewIdOf(w), at, anchor);
                });
            }
            case 'expandOut': return void this.gesture(w, { kind: 'element', id })
                .then(i => this.actions.expand('out', id, viewIdOf(w), this.beside(w, i.box, button, 'out'), { x: b.right + 8, y: b.top }));
            case 'expandTargets': return void this.gesture(w, { kind: 'element', id })
                .then(i => this.actions.expandTargetShapes(id, viewIdOf(w), this.beside(w, i.box, button, 'out'), { x: b.right + 8, y: b.top }));
        }
    }

    /** The element `id` has a node shape card in this view editor (diagram graph). */
    protected isNodeShape(w: CanvasWidget, id: string): boolean {
        return this.editors.diagram(w)?.get(this.editors.placementOf(w, id))?.type === TYPES.SHAPE;
    }

    /** The schema fields of the diagram element that shows `id` in this view editor (its card or edge, else the element with that id). */
    protected shown(w: CanvasWidget, id: string): Record<string, unknown> | undefined {
        return this.editors.diagram(w)?.get(this.editors.placementOf(w, id));
    }

    /**
     * Model point (center) for a new or added card next to `box`, the stored box of an element of the view (GestureInfo.box): 100 px
     * right (out) or left (in) of it. Without a box (not stored yet): next to the halo `button`.
     */
    protected beside(w: CanvasWidget, box: Rect | undefined, button: Element, direction: 'in' | 'out'): Point {
        const b = button.getBoundingClientRect();
        const r = box ?? { ...this.editors.toModel(w, b.left, b.top), width: 0, height: 0 };
        const dx = 100 + DEFAULT_SIZE.width / 2;
        return { x: direction === 'out' ? r.x + r.width + dx : r.x - dx, y: r.y + r.height / 2 };
    }

    /**
     * Connect gesture: dashed line from `from` (client coordinates) to the pointer. During the
     * drag, every element of the view (CONNECTABLE) that is not in `targets`, does not contain one and is not inside one is dimmed; the
     * `source` stays. The target under the pointer is highlighted. `drop` runs on release, with that target or undefined: the same set
     * decides the dimming and the drop.
     */
    protected dragLine(w: CanvasWidget, from: { x: number; y: number }, start: MouseEvent, drop: (e: MouseEvent, target: Element | undefined) => void,
        targets: Promise<Element[]>, source?: Element | null): void {
        const host = w.node;
        const box = host.getBoundingClientRect();
        const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        overlay.classList.add('catenary-connect-overlay');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.classList.add('connect-line');
        overlay.appendChild(line);
        host.appendChild(overlay);
        document.body.classList.add('catenary-grabbing');
        line.setAttribute('x1', String(from.x - box.left));
        line.setAttribute('y1', String(from.y - box.top));
        // The targets come with the answer of the backend; until then nothing is dimmed and nothing is a target.
        const valid = new Set<Element>();
        const dimmed = new Set<Element>();
        let done = false;
        const ready = targets.then(ts => {
            if (done) return;
            ts.forEach(t => valid.add(t));
            // Kept: the targets, the source, their ancestors (a card with a target row) and their descendants (the rows of a target card).
            const kept = new Set<Element>();
            for (const t of source ? [...ts, source] : ts) for (let a: Element | null = t; a && a !== host; a = a.parentElement) kept.add(a);
            // Document order: an ancestor comes first, so a part of a dimmed element is not dimmed twice.
            const inside = (el: Element) => {
                for (let a = el.parentElement; a && a !== host; a = a.parentElement) if (valid.has(a) || a === source || dimmed.has(a)) return true;
                return false;
            };
            for (const el of host.querySelectorAll(CONNECTABLE)) if (!kept.has(el) && !inside(el)) dimmed.add(el);
            dimmed.forEach(el => el.classList.add('connect-dimmed'));
        });
        host.classList.add('connect-dragging');
        // The first target in the stack under the pointer: parallel edges overlap, a dimmed element can cover a target.
        const targetAt = (e: MouseEvent): Element | undefined => {
            for (const el of document.elementsFromPoint(e.clientX, e.clientY))
                for (let a: Element | null = el; a && a !== host; a = a.parentElement) if (valid.has(a)) return a;
            return undefined;
        };
        let hover: Element | undefined;
        let last = start;
        const move = (e: MouseEvent) => {
            last = e;
            line.setAttribute('x2', String(e.clientX - box.left));
            line.setAttribute('y2', String(e.clientY - box.top));
            const target = targetAt(e);
            if (target !== hover) {
                hover?.classList.remove('drop-target');
                hover = target;
                hover?.classList.add('drop-target');
            }
        };
        move(start);
        void ready.then(() => { if (!done) move(last); });
        const up = (e: MouseEvent) => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
            e.stopPropagation();
            // A release before the answer: the drop waits for it.
            void ready.then(() => {
                done = true;
                hover?.classList.remove('drop-target');
                dimmed.forEach(el => el.classList.remove('connect-dimmed'));
                host.classList.remove('connect-dragging');
                overlay.remove();
                document.body.classList.remove('catenary-grabbing');
                drop(e, targetAt(e));
            });
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
    }

    /** The end of an arrow to the box `el` of the view, as the backend checks it (ops.createArrow): its element or box id; '' for none. */
    protected arrowEnd(w: CanvasWidget, el: Element): string {
        return ownerOfLabel(this.idOf(w, el, BOXES) ?? '');
    }

    /** Presses on shape elements: the ⇤ of a property edge (it goes back into its cards). True: handled. */
    protected shapesPress(w: CanvasWidget, target: Element, e: MouseEvent): boolean {
        if (!this.editors.diagram(w) || !target.closest) return false;
        const stop = () => { e.preventDefault(); e.stopPropagation(); return true; };
        if (target.closest('.row-in')) {
            const property = this.idOf(w, target, '.catenary-edge');
            // VS Code glue: Catenary's putBack read the shapes in the frontend; DeleteHandler finds the placement of the property line.
            if (property) void w.actionDispatcher.dispatch(DeleteElementOperation.create([property]));
            return stop();
        }
        if (target.closest('.latent-out')) {
            // The dashed line of a row: the row becomes a line, its end box right of the owner card, level with the button.
            const latent = this.idOf(w, target, '.catenary-edge');
            const edge = latent ? this.editors.diagram(w)?.get(latent) as { sourceId?: string } | undefined : undefined;
            if (latent?.endsWith(LATENT_SUFFIX) && edge?.sourceId) {
                void this.actions.takeOut(viewIdOf(w), latent.slice(0, -LATENT_SUFFIX.length), this.besideMember(w, this.editors.elementOf(w, edge.sourceId), target));
            }
            return stop();
        }
        return false;
    }

    /**
     * The container kinds: a node shape card, an entity group, a value set, a "one of" box. Each declares its row
     * buttons and their effects; containerPress reads this table. ➟ shows the member in its own box beside the row (a shape card: the
     * property row becomes a line; an entity group: the member leaves the group), × removes the member from the view, "+ member" adds
     * one. Not copied: × of a concept or an alternative and the add rows of the others (model edits).
     */
    protected readonly containers: ContainerKind[] = [
        {
            box: '.shape-card', takeOut: '.row-out',
            onTakeOut: p => void this.actions.takeOut(p.view, p.member, p.at)
        }, {
            box: '.catenary-collection', takeOut: '.member-take-out', remove: '.member-remove', add: '.member-add',
            onTakeOut: p => void this.actions.uncollect(p.view, [p.id], [p.member]),
            onRemove: p => void this.actions.removeFromView(p.view, p.member),
            onAdd: p => this.addMember(p.w, p.id, p.button)
        }, {
            box: '.valueset-card', takeOut: '.member-take-out',
            onTakeOut: p => void this.actions.showMembers(p.view, [p.shown], p.at)
        }, {
            box: '.catenary-one-of', takeOut: '.member-take-out',
            onTakeOut: p => void this.actions.showMembers(p.view, [p.shown], p.at)
        }
    ];

    /** A press on a row button of a container (the `containers` table). True: handled. */
    protected containerPress(w: CanvasWidget, target: Element, e: MouseEvent): boolean {
        if (!target.closest) return false;
        for (const kind of this.containers) {
            const buttons = [kind.takeOut, kind.remove, kind.add].filter((x): x is string => !!x).join(', ');
            const button = target.closest(buttons), box = button?.closest(kind.box);
            const id = box && this.idOf(w, box, kind.box);
            if (!button || !box || !id) continue;
            e.preventDefault();
            e.stopPropagation();
            // `member`: the row (data-member). `shown`: what ➟ shows (data-instance; empty: ➟ is disabled; absent: the member itself).
            const member = button.closest('[data-member]')?.getAttribute('data-member') ?? '';
            const press: RowPress = { w, view: viewIdOf(w), id, member, shown: button.getAttribute('data-instance') ?? member, button, at: this.besideMember(w, id, button) };
            if (kind.add && button.matches(kind.add)) kind.onAdd?.(press);
            else if (!member) return true;
            else if (kind.remove && button.matches(kind.remove)) kind.onRemove?.(press);
            else if (press.shown) kind.onTakeOut(press);
            return true;
        }
        return false;
    }

    /** Model point of a member taken out of the container `id`: right of the drawn box, level with the row of `button`. */
    protected besideMember(w: CanvasWidget, id: string, button: Element): Point {
        const drawn = this.shown(w, id) as { position?: Point; size?: { width: number } } | undefined;
        const b = button.getBoundingClientRect(), row = this.editors.toModel(w, b.right, b.top + b.height / 2);
        const right = drawn?.position && drawn.size ? drawn.position.x + drawn.size.width : row.x;
        return { x: right + 100 + DEFAULT_SIZE.width / 2, y: row.y };
    }

    /** After a change, press the element `selector` of `id` again (the next "+ member"). */
    protected reopen(w: CanvasWidget, id: string, selector: string): void {
        const el = this.nodeOf(w, id)?.querySelector(selector);
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 0, detail: 1 }));
    }

    /** "+ member" of an instance collection: an instance by label (Enter: the next one). */
    protected addMember(w: CanvasWidget, collection: string, add: Element): void {
        const view = viewIdOf(w);
        inlineInput({ inside: add, placeholder: 'instance', options: this.actions.memberOptions(view, collection),
            onCommit: async (text, how) => {
                if (await this.actions.addMember(view, collection, text) && how === 'enter') setTimeout(() => this.reopen(w, collection, '.member-add'), 50);
            } });
    }

    /** Arrow button of a note: dashed line from the button to the pointer. Release on another box of the view that has no arrow from the note yet: an arrow to it. */
    protected arrowDrag(w: CanvasWidget, source: string, start: MouseEvent): void {
        const info = this.gesture(w, { kind: 'arrow', source, boxes: this.candidates(w, BOXES, el => this.arrowEnd(w, el)) });
        this.connectDrag(w, start, {
            selector: BOXES, source: this.nodeOf(w, source), info,
            problem: (el, i) => problemIn(i, 'boxes', this.arrowEnd(w, el)),
            drop: (_e, el) => void this.actions.createArrow(viewIdOf(w), source, ownerOfLabel(this.idOf(w, el, BOXES)!)),
        });
    }
}
