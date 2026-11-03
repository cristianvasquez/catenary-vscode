// Request canvas reads and view edits through GLSP actions; adapted from Catenary modeler/src/browser/model-client.ts.
// The server edits the text of the view document and returns results or refusal messages.

import { RequestAction, ResponseAction } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import type { ViewCommand } from '../catenary/model/commands';
import type { Choices } from '../catenary/model/prompts';
import type { GestureInfo, ViewGesture } from '../catenary/model/view-ui';
import {
    CANVAS_EDIT, CanvasEditAction, REQUEST_EDIT, REQUEST_EXPAND, REQUEST_GESTURE, REQUEST_MEMBERS, RequestEditAction, RequestExpandAction, RequestGestureAction,
    RequestMembersAction
} from '../common/protocol';
import { CanvasWidget } from './view-editors';

@injectable()
export class ModelFrontend {
    @inject(CanvasWidget) protected readonly widget: CanvasWidget;

    /** One ViewCommand of a gesture; `select`: the elements to select after it ('result': what it made). Resolves when it is sent. */
    async execute(command: ViewCommand, select?: string[] | 'result'): Promise<{ ok: true }> {
        await this.widget.actionDispatcher.dispatch({ kind: CANVAS_EDIT, command, ...(select ? { select } : {}) } as CanvasEditAction);
        return { ok: true };
    }

    /** One ViewCommand; resolves with the result of the store (the note editor: a refusal keeps the draft). */
    executeChecked(command: ViewCommand): Promise<{ ok: true } | { ok: false; error: string }> {
        return this.request({ kind: REQUEST_EDIT, command, requestId: '' } as RequestEditAction).then(a => a.result);
    }

    protected request<R extends ResponseAction>(action: RequestAction<R>): Promise<R> {
        return this.widget.actionDispatcher.request({ ...action, requestId: RequestAction.generateRequestId() });
    }

    /** The reads of the gestures: the session answers for its view (`_view` names it as Catenary's RPC does). */
    readonly service = {
        viewGesture: (_view: string, gesture: ViewGesture): Promise<GestureInfo> =>
            this.request({ kind: REQUEST_GESTURE, gesture, requestId: '' } as RequestGestureAction).then(a => a.info),
        expandChoices: (_view: string, from: string, dir: RequestExpandAction['dir']): Promise<Choices | undefined> =>
            this.request({ kind: REQUEST_EXPAND, from, dir, requestId: '' } as RequestExpandAction).then(a => a.choices),
        memberOptions: (_view: string, collection: string): Promise<string[]> =>
            this.request({ kind: REQUEST_MEMBERS, collection, requestId: '' } as RequestMembersAction).then(a => a.values),
        instancesNamed: (text: string): Promise<string[]> =>
            this.request({ kind: REQUEST_MEMBERS, collection: '', text, requestId: '' } as RequestMembersAction).then(a => a.values)
    };
}
