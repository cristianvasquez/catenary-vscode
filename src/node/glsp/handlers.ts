// Handle GLSP view operations and read requests; adapted from Catenary modeler/src/node/glsp/handlers.ts.
// Edits use ViewSession.edit; ViewStore owns history and VS Code runs undo and redo.

import {
    Action, ActionHandler, ChangeBoundsOperation, Command, CreateNodeOperation, CreateNodeOperationHandler, DeleteElementOperation,
    OperationHandler, SelectAction, TriggerNodeCreationAction
} from '@eclipse-glsp/server';
import { injectable, inject } from 'inversify';
import { ViewCommand, unnamedLabel } from '../../catenary/model/commands';
import { boxes, placementOfId } from '../../catenary/model/doc';
import { LEAF_SUFFIX, TYPES, ownerOfLabel } from '../../catenary/model/diagram-schema';
import { viewGesture } from '../../catenary/model/view-ui';
import {
    SET_CARD_SCALE, type SetCardScaleAction, CANVAS_EDIT, EXPAND_CHOICES, GESTURE_ANSWER, REQUEST_EXPAND, REQUEST_GESTURE, type CanvasEditAction, type ExpandChoicesAction, type GestureAnswerAction,
    type RequestExpandAction, type RequestGestureAction
} from '../../common/protocol';
import { isTakenOut, propertyNodeId } from '../../catenary/model/shapes-schema';
import { MEMBER_CHOICES, REQUEST_MEMBERS, type MemberChoicesAction, type RequestMembersAction } from '../../common/protocol';
import { EDIT_RESULT, REQUEST_EDIT, type EditResultAction, type RequestEditAction } from '../../common/protocol';
import { ViewSession, type EditResult } from './view-session';
import { FitToScreenAction, PasteOperation, RequestClipboardDataAction, SetClipboardDataAction, StatusAction } from '@eclipse-glsp/server';
import * as model from '../../catenary/model/doc';
import { VIEW_CLIP_FORMAT, copyFromView, isViewClip, type ViewClip } from '../../catenary/model/commands';
import { iriId } from '../../catenary/model/ids';

/** Select the created element. It has a default name: double-click a group label to rename it, or a note to edit its Markdown. */
const selectCreated = (r: EditResult): Action[] => r.id ? [SelectAction.create({ selectedElementsIDs: [r.id], deselectedElementsIDs: true })] : [];

@injectable()
export class CreateNoteHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.NOTE];
    readonly label = 'Note';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [TriggerNodeCreationAction.create(TYPES.NOTE)];
    }

    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const at = op.location ?? { x: 0, y: 0 };
        await this.session.edit({ kind: 'createNote', view: this.session.viewId, text: 'Note', at }, selectCreated);
        return undefined;
    }
}

@injectable()
export class CreateGroupHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.GROUP];
    readonly label = 'Group';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [TriggerNodeCreationAction.create(TYPES.GROUP)];
    }

    /** `args.around`: the boxes of the selection (palette Group with boxes selected, Catenary's New Group), one id per line. */
    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const at = op.location ?? { x: 0, y: 0 };
        const label = unnamedLabel('group', boxes(this.session.view, 'group'));
        const around = String(op.args?.around ?? '').split('\n').filter(Boolean);
        await this.session.edit({ kind: 'createGroup', view: this.session.viewId, label, ...(around.length ? { around } : {}),
            rect: { x: at.x, y: at.y, width: 600, height: 400 } }, selectCreated);
        return undefined;
    }
}

@injectable()
export class ChangeBoundsHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = ChangeBoundsOperation.KIND;

    async createCommand(op: ChangeBoundsOperation): Promise<Command | undefined> {
        const bounds = op.newBounds.map(b => ({ id: b.elementId, x: b.newPosition?.x, y: b.newPosition?.y, width: b.newSize.width, height: b.newSize.height }));
        await this.session.edit({ kind: 'setBounds', view: this.session.viewId, bounds });
        return undefined;
    }
}

/**
 * Del in a view: cards leave the view, edges are hidden in the view, groups are deleted. The model keeps the instances.
 * Shapes view: a property taken out of its card goes back into it; rows and other property edges stay.
 */
@injectable()
export class DeleteHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = DeleteElementOperation.KIND;

    async createCommand(op: DeleteElementOperation): Promise<Command | undefined> {
        const { shapes } = this.session.part;
        const view = this.session.view;
        // Leaf boxes keep their id (`<property>_leaf`): the command finds their placed term.
        const all = [...new Set(op.elementIds.map(id => id.endsWith(LEAF_SUFFIX) ? id : ownerOfLabel(id)))];
        // A property line: its placement (shared by the owners of a shared property). A hub member, a hub: the hub unit.
        const ids = all.flatMap(id => {
            const p = shapes.properties[id];
            if (!p) return [id];
            return p.constraint ? [id] : isTakenOut(view, p) ? [propertyNodeId(p)] : [];
        });
        if (ids.length === 0) {
            await this.session.message('A property stays in its node shape.', 'INFO');
            return undefined;
        }
        await this.session.edit({ kind: 'removeFromView', view: this.session.viewId, ids });
        return undefined;
    }
}

/** A canvas gesture: one ViewCommand for the view of this session (CanvasEditAction), then the selection it asks for. */
@injectable()
export class CanvasEditHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [CANVAS_EDIT];

    async execute(action: Action): Promise<Action[]> {
        const { command, select } = action as CanvasEditAction;
        await this.session.edit({ ...command, ...('view' in command ? { view: this.session.viewId } : {}) } as ViewCommand, r => {
            // Explicit ids are elements: their placements in this view (the result ids are placements already).
            const view = this.session.view;
            const ids = select === 'result' ? r.ids ?? (r.id ? [r.id] : []) : select?.map(id => placementOfId(view, id));
            return ids?.length ? [SelectAction.create({ selectedElementsIDs: ids, deselectedElementsIDs: true })] : [];
        });
        return [];
    }
}

/** Client request: the choices of a halo expand button (Catenary RPC neighborChoices, shapeSourceChoices, shapeTargetChoices). */
@injectable()
export class RequestExpandHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [REQUEST_EXPAND];

    execute(action: Action): Action[] {
        const { from, dir, requestId } = action as RequestExpandAction;
        const choices = this.session.store.expandChoices(this.session.viewId, from, dir);
        return [{ kind: EXPAND_CHOICES, responseId: requestId, choices } as ExpandChoicesAction];
    }
}

/** Client request: one ViewCommand for the view of this session, answered with the result of the store. */
@injectable()
export class RequestEditHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [REQUEST_EDIT];

    async execute(action: Action): Promise<Action[]> {
        const { command, requestId } = action as RequestEditAction;
        const result = await this.session.edit({ ...command, ...('view' in command ? { view: this.session.viewId } : {}) } as ViewCommand);
        return [{ kind: EDIT_RESULT, responseId: requestId, result } as EditResultAction];
    }
}

/** Client request: the reads of "+ member" of an entity group (Catenary RPC memberOptions, instancesNamed). */
@injectable()
export class RequestMembersHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [REQUEST_MEMBERS];

    execute(action: Action): Action[] {
        const { collection, text, requestId } = action as RequestMembersAction;
        const store = this.session.store;
        const values = text === undefined ? store.memberOptions(this.session.viewId, collection) : store.instancesNamed(text);
        return [{ kind: MEMBER_CHOICES, responseId: requestId, values } as MemberChoicesAction];
    }
}

/** Client request: the answer of the backend for a gesture of the canvas (Catenary RPC viewGesture). */
@injectable()
export class RequestGestureHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [REQUEST_GESTURE];

    execute(action: Action): Action[] {
        const { gesture, requestId } = action as RequestGestureAction;
        const part = this.session.part;
        return [{ kind: GESTURE_ANSWER, responseId: requestId, info: viewGesture(part, part.views[this.session.viewId], gesture) } as GestureAnswerAction];
    }
}

@injectable()
export class SetCardScaleHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [SET_CARD_SCALE];

    async execute(action: Action): Promise<Action[]> {
        const scale = (action as SetCardScaleAction).scale;
        if (!(scale > 0) || scale === this.session.state.cardScale) return [];
        this.session.state.cardScale = scale;
        // Before the first model request there is no view to send.
        if (this.session.viewId) await this.session.refresh();
        return [];
    }
}

// Copy, cut and paste between views. From Catenary modeler/src/node/glsp/handlers.ts. The client keeps the clip of its canvas and
// sends it back with the paste; VS Code glue: each view editor is its own webview, so the server also keeps the last clip of the folder
// (ViewSource.clip, by the clip id of the client) for a paste in another canvas. The client marks a cut with `args.mode = 'cut'`.
// A paste places the same elements, never new ones. A paste of a cut moves them from the source view of the clip
// (moveBetweenViews): one command. A cut alone changes nothing. The counts of a paste show in the status of the canvas (Catenary:
// PASTE_RESULT and the cut mark of the window).

@injectable()
export class RequestClipboardDataHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [RequestClipboardDataAction.KIND];

    execute(action: RequestClipboardDataAction): Action[] {
        const ids = [...new Set(action.editorContext.selectedElementIds.map(ownerOfLabel))];
        const mode = action.editorContext.args?.mode === 'cut' ? 'cut' : 'copy';
        const clip = copyFromView(this.session.part, this.session.viewId, ids, mode);
        const id = action.editorContext.args?.clipboardId;
        if (clip && typeof id === 'string') this.session.store.clip = { id, data: JSON.stringify(clip) };
        return [SetClipboardDataAction.create(clip ? { format: VIEW_CLIP_FORMAT, [VIEW_CLIP_FORMAT]: JSON.stringify(clip) } : {})];
    }
}

/** The boxes of a clip that `view` shows already, as pasteIntoView counts them: a card of its element, a reference to its view. */
function shownBoxes(view: model.View | undefined, clip: ViewClip): number {
    const elements = new Set(model.boxes(view, 'card').map(c => c.element));
    for (const c of model.boxes(view, 'collection')) for (const m of c.members) elements.add(m);
    const views = new Set(model.boxes(view, 'reference').flatMap(r => r.target ? [r.target] : []));
    return clip.boxes.filter(b => b.kind === 'card' ? elements.has(iriId(b.id))
        : b.kind === 'reference' && !!b.target && views.has(iriId(b.target))).length;
}

/** The status message of a paste: the placed count, then the skipped and the missing counts when they are not zero (Catenary cut-mark.ts). */
function pasteMessage(placed: number, skipped: number, missing: number): string {
    return `Placed ${placed}.` + (skipped ? ` Skipped ${skipped} already in this view.` : '') + (missing ? ` ${missing} missing from this model.` : '');
}

@injectable()
export class PasteHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = PasteOperation.KIND;

    async createCommand(op: PasteOperation): Promise<Command | undefined> {
        const last = this.session.store.clip;
        let clip: unknown;
        try {
            clip = JSON.parse(op.clipboardData[VIEW_CLIP_FORMAT] ?? (last && last.id === op.clipboardData.clipboardId ? last.data : 'null'));
        } catch {
            clip = undefined;
        }
        if (!isViewClip(clip)) {
            await this.session.message('The clipboard does not hold view elements.');
            return undefined;
        }
        const before = new Set(this.session.view?.boxes.map(b => b.id));
        // A move within this view re-places its cards (same placement ids): they arrive again.
        const within = clip.mode === 'cut' && iriId(clip.source) === this.session.viewId;
        if (within) for (const b of clip.boxes) if (b.kind === 'card') before.delete(model.placementOfId(this.session.view, iriId(b.id)));
        const skipped = within ? 0 : shownBoxes(this.session.view, clip);
        const result = (placed: number, missing: number): string =>
            clip.mode === 'cut' && placed === 0 && missing === 0 ? 'Already in this view.' : pasteMessage(placed, skipped, missing);
        // The view shows all of them: no command, the reply only.
        if (skipped > 0 && skipped === clip.boxes.length) {
            await this.session.status(result(0, 0));
            return undefined;
        }
        const at = op.editorContext.lastMousePosition, cardScale = this.session.state.cardScale;
        const command: ViewCommand = clip.mode === 'cut'
            ? { kind: 'moveBetweenViews', from: clip.source, to: this.session.viewId, clip, at, cardScale }
            : { kind: 'pasteIntoView', view: this.session.viewId, clip, at, cardScale };
        await this.session.edit(command, r => {
            const ids = r.ids ?? [];
            const added = ids.filter(id => !before.has(id));
            // One id for each box of this model: the placed ones, then the shown ones. The other boxes are missing from this model.
            return [SelectAction.create({ selectedElementsIDs: ids, deselectedElementsIDs: true }),
                ...(added.length ? [FitToScreenAction.create(added, { padding: 40, maxZoom: 1, animate: false })] : []),
                StatusAction.create(result(ids.length - skipped, clip.boxes.length - ids.length), { severity: 'INFO', timeout: 10000 })];
        });
        return undefined;
    }
}
