// Keep client move/resize bounds until the server confirms them; adapted from Catenary modeler/src/browser/diagram/pending-bounds.ts.
// Older models cannot undo a pending drag; after 3 seconds without confirmation, use server bounds.

import {
    Action, ChangeBoundsOperation, CommandExecutionContext, CommandReturn, CompoundOperation, FeedbackCommand, IActionHandler, IFeedbackActionDispatcher, TYPES
} from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { APPLY_PENDING_BOUNDS } from '../common/protocol';
import { ModelRoot, PendingBoundsState } from './pending-bounds-state';

export interface ApplyPendingBoundsAction extends Action {
    kind: typeof ApplyPendingBoundsAction.KIND;
}
export namespace ApplyPendingBoundsAction {
    export const KIND = APPLY_PENDING_BOUNDS;
    export const create = (): ApplyPendingBoundsAction => ({ kind: KIND });
}

/** Records each ChangeBoundsOperation that this client sends (also in a CompoundOperation), and keeps the feedback registered. */
@injectable()
export class PendingBounds implements IActionHandler {
    @inject(TYPES.IFeedbackActionDispatcher) protected readonly feedback: IFeedbackActionDispatcher;
    readonly state = new PendingBoundsState();
    protected readonly emitter = {};

    handle(action: Action): void {
        // The move tool sends its ChangeBoundsOperation in a CompoundOperation; the resize tool sends it alone.
        const operations = CompoundOperation.is(action) ? action.operationList : [action];
        for (const op of operations) if (ChangeBoundsOperation.is(op)) this.record(op);
    }

    protected record(action: ChangeBoundsOperation): void {
        const at = Date.now();
        for (const b of action.newBounds) {
            if (!b.newPosition) continue;
            const bounds = { x: b.newPosition.x, y: b.newPosition.y, width: b.newSize.width, height: b.newSize.height };
            const entry = this.state.sent.get(b.elementId);
            if (entry) {
                entry.bounds.push(bounds);
                entry.at = at;
            } else this.state.sent.set(b.elementId, { bounds: [bounds], at });
        }
        this.feedback.registerFeedback(this.emitter, [ApplyPendingBoundsAction.create()]);
    }
}

/** The feedback command: runs on each new model (FeedbackAwareUpdateModelCommand) before it renders. */
@injectable()
export class ApplyPendingBoundsCommand extends FeedbackCommand {
    static readonly KIND = ApplyPendingBoundsAction.KIND;
    @inject(PendingBounds) protected readonly pending: PendingBounds;

    constructor(@inject(TYPES.Action) protected readonly action: ApplyPendingBoundsAction) {
        super();
    }

    execute(context: CommandExecutionContext): CommandReturn {
        this.pending.state.apply(context.root as unknown as ModelRoot);
        return context.root;
    }
}
