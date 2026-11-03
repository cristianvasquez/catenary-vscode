// Run view-only canvas actions with popup pickers; adapted from Catenary modeler/src/browser/actions.ts.
// The backend supplies choices and edits; messages use GLSP and selections follow edit results.

import { MessageAction } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import type { ViewCommand, Point } from '../catenary/model/commands';
import { LAYOUT_VIEW, type LayoutViewAction, LAYOUT_ALGORITHMS, LAYOUT_SPACING } from '../common/protocol';
import { ModelFrontend } from './model-client';
import { PopupItem, PopupSeparator, showPopupPicker } from './popup-picker';
import { CanvasWidget } from './view-editors';

/** Client coordinates: pickers open there, next to the element. */
type Anchor = { x: number; y: number };

@injectable()
export class ModelActions {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(CanvasWidget) protected readonly widget: CanvasWidget;

    protected get service() { return this.model.service; }

    /** A message in a VS Code notification (Catenary: MessageService). */
    warn(text: string): void {
        void this.widget.actionDispatcher.dispatch(MessageAction.create(text, { severity: 'WARNING' }));
    }

    /** One command; the session selects `ids` after it (default: the element that it made). */
    protected async executeAndSelect(_view: string, command: ViewCommand, ids?: string[]): Promise<{ ok: true }> {
        return this.model.execute(command, ids ?? 'result');
    }

    /**
     * Halo expand button of a card: the instances related to `from` (dir 'in': subjects of its relations; 'out': objects) that the view
     * does not show. A pick adds its card at `at` and shows its relations to `from`; "Show all N" does it for all. Creates nothing.
     */
    async expand(dir: 'out' | 'in', from: string, view: string, at: Point, anchor: Anchor): Promise<void> {
        const choices = await this.service.expandChoices(view, from, dir);
        if (!choices) return;
        const { title, items } = choices;
        await this.pick(title, [
            ...(items.length > 1 ? [{ label: `Show all ${items.length} in the view`, run: () => this.showRelations(view, items.flatMap(i => i.ids), at) }] : []),
            ...items.map(i => ({ label: i.label, description: i.description, run: () => this.showRelations(view, i.ids, at) }))
        ], anchor);
    }

    /**
     * Halo incoming button of a node shape card: the node shapes with a property to `from` that the view does not show. A pick adds its
     * card at `at`; "Show all N" adds all. The lines to `from` are placed in the same step. Creates nothing.
     */
    async expandShape(from: string, view: string, at: Point, anchor: Anchor): Promise<void> {
        const choices = await this.service.expandChoices(view, from, 'in');
        if (!choices) return;
        const { title, items } = choices;
        const add = (ids: string[]) => this.executeAndSelect(view, { kind: 'addToView', view, ids, at }, ids);
        await this.pick(title, [
            ...(items.length > 1 ? [{ label: `Show all ${items.length} in the view`, run: () => add(items.flatMap(i => i.ids)) }] : []),
            ...items.map(i => ({ label: i.label, description: i.description, run: () => add(i.ids) }))
        ], anchor);
    }

    /** Halo button of an instance card: applicable node shapes not shown in the view. */
    async expandTargetShapes(from: string, view: string, at: Point, anchor: Anchor): Promise<void> {
        const choices = await this.service.expandChoices(view, from, 'targets');
        if (!choices) return;
        const { title, items } = choices;
        const add = (ids: string[]) => this.executeAndSelect(view, { kind: 'addToView', view, ids, at }, ids);
        await this.pick(title, [
            ...(items.length > 1 ? [{ label: `Show all ${items.length} in the view`, run: () => add(items.flatMap(i => i.ids)) }] : []),
            ...items.map(i => ({ label: i.label, description: i.description, run: () => add(i.ids) }))
        ], anchor);
    }

    /** Arrow from one box of the view to another; one end is a note. */
    async createArrow(view: string, from: string, to: string): Promise<void> {
        await this.executeAndSelect(view, { kind: 'createArrow', view, from, to });
    }

    /** Add the subject and object of the relations to the view (around `at`) and show the edges. */
    async showRelations(view: string, ids: string[], at: Point): Promise<void> {
        await this.executeAndSelect(view, { kind: 'showRelations', view, ids, at }, ids);
    }

    /** Collect cards (and collections) of a view into one collection, selected. */
    async collect(view: string, ids: string[]): Promise<void> {
        await this.executeAndSelect(view, { kind: 'collect', view, ids });
    }

    /** Take members out of collections (all members without `members`). The cards taken out are selected. */
    async uncollect(view: string, collections: string[], members?: string[]): Promise<void> {
        for (const id of collections) await this.model.execute({ kind: 'uncollect', view, id, ids: members }, 'result');
    }

    /**
     * Members of a member-list box (a concept of a value set, the card of an alternative of a "one of" box) get their own cards, centered at
     * `at` (beside the box). Their rows go: the view draws the line from the box to each card (a concept is drawn once in a view).
     */
    async showMembers(view: string, ids: string[], at: Point): Promise<void> {
        await this.executeAndSelect(view, { kind: 'addToView', view, ids, at }, ids);
    }

    /** A property row (or the head of a logical constraint) of a shape card becomes a line, with its end box centered at `at`. */
    async takeOut(view: string, id: string, at: Point): Promise<void> {
        await this.executeAndSelect(view, { kind: 'showAsEdge', view, id, at }, [id]);
    }

    /** The card of an instance leaves the view (and its collection). The model does not change. */
    async removeFromView(view: string, id: string): Promise<void> {
        await this.model.execute({ kind: 'removeFromView', view, ids: [id] });
    }

    /** Labels of the instances that are not members of `collection` (for "+ member"). */
    memberOptions(view: string, collection: string): Promise<string[]> {
        return this.service.memberOptions(view, collection);
    }

    /** An instance joins a collection, by label or IRI. False when no instance or more than one has that label. */
    async addMember(view: string, collection: string, text: string): Promise<boolean> {
        const t = text.trim();
        if (!t) return false;
        const found = await this.service.instancesNamed(t);
        if (found.length !== 1) { this.warn(found.length ? `More than one instance is "${t}": use its IRI.` : `No instance "${t}".`); return false; }
        const r = await this.model.execute({ kind: 'addToCollection', view, id: collection, ids: [found[0]] });
        return r.ok;
    }

    /**
     * Apply Layout: pick an algorithm, then the view editor lays out its view (one undo step). VS Code glue: the pick is the popup picker
     * at `anchor` (Catenary: a quick pick), the spacing is the default (Catenary: the preference catenary.layoutSpacing).
     */
    async layoutView(anchor: Anchor): Promise<void> {
        await this.pick('Layout algorithm', LAYOUT_ALGORITHMS.map(a => ({ label: a.label, description: a.description,
            run: () => {
                const action: LayoutViewAction = { kind: LAYOUT_VIEW, algorithm: a.id, spacing: LAYOUT_SPACING.default };
                void this.widget.actionDispatcher.dispatch(action);
            } })), anchor);
    }

    pick(title: string, items: (PopupItem | PopupSeparator)[], anchor: Anchor): Promise<unknown> {
        return showPopupPicker({ at: anchor, title, items });
    }
}
