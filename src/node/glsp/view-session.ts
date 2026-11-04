// Read and refresh one GLSP view and route edits to the workspace; adapted from Catenary modeler/src/node/glsp/view-session.ts.
// Each edit is one text edit of the view document (one VS Code undo step); refreshes must not replace a newer edit model. The session
// computes the diagram (async, turtle/query) into ViewState before it submits; the synchronous GModelFactory reads it.

import {
    Action, ClientActionForwarder, ClientActionKinds, ClientId, ClientSessionManager, GModelFactory, GModelRoot, GModelSerializer,
    MessageAction, ModelState, ModelSubmissionHandler, ActionDispatcher, RequestModelAction, SaveModelAction, SetModelAction, SourceModelStorage, StatusAction, UpdateModelAction
} from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { viewIdOfUri } from '../../common/protocol';
import type { ViewCommand } from '../../catenary/model/commands';
import { Doc, View, placementOfId } from '../../catenary/model/doc';
import type { Choices } from '../../catenary/model/prompts';
import type { Result } from '../../edit/ops';
import type { Violation } from '../../catenary/model/validation';
import { type DiagramOptions, type Drawn, type DrawingUpdate, emptyDrawn, keepGeometry } from '../../read/diagram';

/** The workspace that the sessions read and edit. */
export interface ViewSource {
    readonly violations?: Violation[];
    /** The schema, the Doc and the figures of the view `viewId` (element id); an empty diagram before the first turtle-lsp answer. */
    diagram(viewId: string, opts: DiagramOptions): Promise<Drawn>;
    /** The pickers of the halo and of "+ member" (read/choices.ts). */
    expandChoices(viewId: string, from: string, dir: 'in' | 'out' | 'targets'): Promise<Choices | undefined>;
    memberOptions(viewId: string, collection: string): Promise<string[]>;
    instancesNamed(text: string): Promise<string[]>;
    onDidChange(listener: (update?: DrawingUpdate) => void): { dispose(): void };
    /** One edit of the view `viewId` (element id): a text edit of its document; refused when no editor has the view open. */
    execute(viewId: string, command: ViewCommand): Promise<Result<unknown>>;
    /** The last clip of a copy or cut in any canvas of the folder: each view editor is its own webview (handlers.ts PasteHandler). */
    clip?: { id: string; data: string };
}
export const ViewSource = Symbol('ViewSource');

/** Session state: the view shown and the Show level (hidden edges, derived connectors). No dependencies on GLSP services (avoids DI cycles). */
@injectable()
export class ViewState {
    @inject(ViewSource) readonly store: ViewSource;
    viewId = '';
    /** Card text scale of the client (`catenarySetCardScale`): minimum heights of cards with rows. */
    cardScale = 1;
    /** The last diagram computed (ViewSession.draw): createModel submits its schema; `doc` is the read model of the handlers. */
    drawn: Drawn = emptyDrawn();
}

/** The ids that an edit made (Result.value: an id or ids) and the follow-up of the session (Catenary CommandResult). */
export interface EditResult { id?: string; ids?: string[] }

const editWarning = (kind: string, what: string, reason: string): MessageAction =>
    MessageAction.create(`"${kind}" ${what}: ${reason}`, { severity: 'WARNING' });

/** Sends updates to the client. One per session. */
@injectable()
export class ViewSession {
    @inject(ViewState) readonly state: ViewState;
    @inject(ModelSubmissionHandler) protected readonly submission: ModelSubmissionHandler;
    @inject(ActionDispatcher) protected readonly dispatcher: ActionDispatcher;
    @inject(ClientSessionManager) protected readonly sessions: ClientSessionManager;
    @inject(ClientId) protected readonly clientId: string;

    protected started = false;
    /** During an edit: the workspace change of the edit does not refresh this session (the edit sends its own update). */
    protected muted = false;
    /** The number of the last draw started: an earlier draw that ends later does not replace its result. */
    protected draws = 0;

    get store(): ViewSource { return this.state.store; }
    get viewId(): string { return this.state.viewId; }

    /** The read model of this view, from the last draw: the view, its instances, the relations between them and the shapes. */
    get part(): Doc { return this.state.drawn.doc; }

    get view(): View | undefined { return this.part.views[this.viewId]; }

    start(viewId: string): void {
        this.state.viewId = viewId;
        if (this.started) return;
        this.started = true;
        const listener = this.store.onDidChange(update => {
            if (this.muted) return;
            if (update) { void this.complete(update); return; }
            void this.refresh();
        });
        const sessionListener = {
            sessionDisposed: () => {
                listener.dispose();
                this.sessions.removeListener(sessionListener);
            }
        };
        this.sessions.addListener(sessionListener, this.clientId);
    }

    /** A completion belongs to exactly the phase-1 model that this session still shows. */
    protected async complete(update: DrawingUpdate): Promise<void> {
        if (update.viewId !== this.viewId || this.state.drawn !== update.base) return;
        try {
            this.state.drawn = { ...update.drawn, schema: keepGeometry(update.drawn.schema, this.state.drawn.schema) };
            const actions = await this.submission.submitModel('operation');
            await this.dispatcher.dispatchAll(actions);
        } catch (e) { console.error('[catenary] completion failed', e); }
    }

    /** Computes the diagram of the view into the state. */
    async draw(): Promise<void> {
        const n = ++this.draws;
        const drawn = await this.store.diagram(this.viewId, { cardScale: this.state.cardScale, violations: this.store.violations });
        if (n === this.draws) this.state.drawn = drawn;
    }

    /** Send the current diagram to the client. */
    async refresh(): Promise<void> {
        // Yield so display work starts after the caller has returned.
        await new Promise<void>(resolve => setImmediate(resolve));
        try {
            await this.draw();
            const actions = await this.submission.submitModel('operation');
            await this.dispatcher.dispatchAll(actions);
        } catch (e) {
            console.error('[catenary] refresh failed', e);
        }
    }

    /**
     * Run an edit for this session: the one edit path of a canvas operation. The session sends its own
     * update first, then `followUp` (for example a selection of the created element). An error of the edit reaches the client as
     * one warning with the command kind and the message: a refused command with the model (the canvas shows the store again), a
     * command that threw without a model. Resolves with the result of the command (a note commit keeps its draft on a refusal). The draw
     * after the edit reads the new text: the language server receives the change of the document before the next request.
     */
    async edit(command: ViewCommand, followUp?: (r: EditResult) => Action[]): Promise<{ ok: true } | { ok: false; error: string }> {
        this.muted = true;
        let r: Result<unknown>;
        try {
            r = await this.store.execute(this.viewId, command);
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            await this.dispatcher.dispatchAll([editWarning(command.kind, 'failed in the backend', error)]);
            return { ok: false, error };
        } finally {
            this.muted = false;
        }
        if (!r.ok) {
            await this.draw();
            await this.dispatcher.dispatchAll([editWarning(command.kind, 'refused', r.error), ...await this.submission.submitModel('operation')]);
            return { ok: false, error: r.error };
        }
        await this.draw();
        const actions = await this.submission.submitModel('operation');
        // The diagram identifies a card or an edge by its placement: the created elements by their placement in this view.
        const view = this.view, shown = (id: string) => placementOfId(view, id);
        const value = r.value;
        const result: EditResult = typeof value === 'string' ? { id: shown(value) } : Array.isArray(value) ? { ids: value.filter((x): x is string => typeof x === 'string').map(shown) } : {};
        await this.dispatcher.dispatchAll([...actions, ...(followUp?.(result) ?? [])]);
        return { ok: true };
    }

    /** A message in the status of the canvas (GLSP StatusOverlay). */
    status(text: string, severity: 'INFO' | 'WARNING' = 'INFO'): Promise<void> {
        return this.dispatcher.dispatch(StatusAction.create(text, { severity, timeout: 10000 }));
    }

    message(text: string, severity: 'INFO' | 'WARNING' | 'ERROR' = 'WARNING'): Promise<void> {
        return this.dispatcher.dispatch(MessageAction.create(text, { severity }));
    }
}

/**
 * Forwards the actions of one session to its client. It drops an update whose revision is lower than or equal to the highest revision
 * sent: a refresh model that leaves the action queue after the newer model of an edit.
 * GLSP sets the revision when it builds the model (ModelSubmissionHandler.submitModel), and every dispatch, queued or inline, passes
 * here when it is sent (DefaultActionDispatcher.doDispatch). An initial model (SetModelAction, a reload) starts the count again.
 */
@injectable()
export class RevisionGuardForwarder extends ClientActionForwarder {
    /** The highest model revision sent to the client. */
    protected sentRevision?: number;

    constructor(@inject(ClientActionKinds) actionKinds: Set<string>) {
        super(actionKinds);
    }

    override handle(action: Action): boolean {
        if (SetModelAction.is(action)) this.sentRevision = action.newRoot.revision;
        else if (UpdateModelAction.is(action) && action.newRoot.revision !== undefined) {
            // Dropped: report it as handled on the client, so the dispatcher does not look for a server handler.
            if (this.sentRevision !== undefined && action.newRoot.revision <= this.sentRevision) return true;
            this.sentRevision = action.newRoot.revision;
        }
        return super.handle(action);
    }
}

/** Reads the view id from the source URI (catenary-view:/<view id>) and starts the session. */
@injectable()
export class ViewModelStorage implements SourceModelStorage {
    @inject(ViewSession) protected readonly session: ViewSession;

    /** Starts the session and computes the first diagram before GLSP calls createModel. */
    async loadSourceModel(action: RequestModelAction): Promise<void> {
        const uri = String(action.options?.uri ?? action.options?.sourceUri ?? '');
        const viewId = viewIdOfUri(uri);
        if (!viewId) throw new Error(`Not a view URI: ${uri}`);
        this.session.start(viewId);
        await this.session.draw();
    }

    /** VS Code saves the view document (a text document of the custom text editor); a GLSP save has nothing to write. */
    saveSourceModel(_action: SaveModelAction): void { /* VS Code writes the view file */ }
}

@injectable()
export class ViewGModelFactory implements GModelFactory {
    @inject(ViewState) protected readonly session: ViewState;
    @inject(ModelState) protected readonly modelState: ModelState;
    @inject(GModelSerializer) protected readonly serializer: GModelSerializer;

    /** The schema of the last draw (ViewSession.draw, read/diagram.ts diagramOf). Diagnostics come from turtle-lsp. */
    createModel(): void {
        const schema = this.session.drawn.schema;
        const root = this.serializer.createRoot(schema as never) as GModelRoot;
        this.modelState.updateRoot(root);
    }
}
