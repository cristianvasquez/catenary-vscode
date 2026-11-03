// The canvas page of one view (canvas.html), in an iframe of the page as a VS Code webview is: the GLSP client of webview/ with a JSON-RPC
// connection over a MessagePort to the page's GLSP server (web/server.ts). The page sends `start` with two ports: `glsp` and `host`.
// Host notifications (insert, open text, paste, open in, drop) and undo, redo and save keys go to the page over `host`.
import 'reflect-metadata';
import '@vscode/codicons/dist/codicon.css';
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
import '@eclipse-glsp/client/css/glsp-sprotty.css';
import '../webview/canvas.css';
import {
    Action, ActionHandlerRegistry, BaseJsonrpcGLSPClient, DiagramLoader, EditMode, EndProgressAction, FitToScreenAction, FocusStateChangedAction,
    IActionDispatcher, IActionHandler, IActionHandlerInitializer, MessageAction, StartProgressAction, TYPES, UpdateProgressAction, ViewerOptions,
    bindAsService, contextMenuModule, standaloneSelectModule
} from '@eclipse-glsp/client';
import { Container, ContainerModule, inject, injectable } from 'inversify';
import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection } from 'vscode-jsonrpc/browser';
import { DIAGRAM_TYPE, VIEW_SCHEME, INSERT_ELEMENT, OPEN_TEXT, OPEN_IN_EVENT, DROP_FILES_EVENT } from '../common/protocol';
import { ViewDiagramConfiguration } from '../webview/diagram-configuration';
import { EdgePreferences } from '../webview/edge-preferences';
import { FontPreferences } from '../webview/font-preferences';
import { NoteMarkdown } from '../webview/note-markdown';
import { CanvasPreferences, type PreferenceValues } from '../webview/preferences';
import { PASTE_RDF_EVENT } from '../webview/clipboard';

/** Page to canvas. */
export type ToCanvas = { type: 'preferences'; values: PreferenceValues } | { type: 'action'; action: Action };
/** Canvas to page. */
export type FromCanvas = { type: 'event'; name: string; detail?: unknown } | { type: 'key'; key: 'undo' | 'redo' | 'save' } | { type: 'notify'; action: Action };
export interface CanvasStartMessage { type: 'start'; clientId: string; view: string; preferences: PreferenceValues }

const configuration = new ViewDiagramConfiguration();
const HostPost = Symbol('HostPost');

/** Messages and progress go to the page, as the VS Code integration sends them to the extension host (vscodeNotificationModule). */
@injectable()
class HostNotificationHandler implements IActionHandler, IActionHandlerInitializer {
    @inject(HostPost) protected readonly post: (m: FromCanvas) => void;

    initialize(registry: ActionHandlerRegistry): void {
        for (const kind of [MessageAction.KIND, StartProgressAction.KIND, UpdateProgressAction.KIND, EndProgressAction.KIND]) registry.register(kind, this);
    }

    handle(action: Action): void {
        this.post({ type: 'notify', action });
    }
}

async function start(message: CanvasStartMessage, glsp: MessagePort, host: MessagePort): Promise<void> {
    const post = (m: FromCanvas) => host.postMessage(m);
    // The DOM of GLSPDiagramWidget (VS Code integration): <clientId>_container holds the diagram div; the hidden div is in the body.
    const containerDiv = document.createElement('div');
    containerDiv.id = `${message.clientId}_container`;
    containerDiv.className = 'catenary-canvas';
    document.body.append(containerDiv);

    const connection = createMessageConnection(new BrowserMessageReader(glsp), new BrowserMessageWriter(glsp));
    const client = new BaseJsonrpcGLSPClient({ id: DIAGRAM_TYPE, connectionProvider: connection });
    const hostModule = new ContainerModule(bind => {
        bind(HostPost).toConstantValue(post);
        bindAsService(bind, TYPES.IActionHandlerInitializer, HostNotificationHandler);
        bind(CanvasPreferences).toSelf().inSingletonScope();
        bind(FontPreferences).toSelf().inSingletonScope();
        bind(EdgePreferences).toSelf().inSingletonScope();
        bind(NoteMarkdown).toSelf().inSingletonScope();
    });
    const options = configuration.createDiagramOptionsModule({
        clientId: message.clientId, diagramType: DIAGRAM_TYPE, glspClientProvider: async () => client,
        sourceUri: `${VIEW_SCHEME}:/${message.view}`, editMode: EditMode.EDITABLE
    });
    const container = configuration.configureContainer(new Container(), options, { add: [standaloneSelectModule], remove: [contextMenuModule] }, hostModule);

    for (const name of [INSERT_ELEMENT, OPEN_TEXT]) document.addEventListener(name, () => post({ type: 'event', name }));
    for (const name of [PASTE_RDF_EVENT, OPEN_IN_EVENT, DROP_FILES_EVENT]) document.addEventListener(name, e => post({ type: 'event', name, detail: (e as CustomEvent).detail }));
    // The page keeps the undo history and saves (VS Code: the custom editor). A text field keeps its own keys.
    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
        const k = e.key.toLowerCase();
        const key = k === 'z' && !e.shiftKey ? 'undo' : k === 'y' || (k === 'z' && e.shiftKey) ? 'redo' : k === 's' ? 'save' : undefined;
        if (!key) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        post({ type: 'key', key });
    }, true);

    const preferences = container.get(CanvasPreferences);
    preferences.update(message.preferences);
    const dispatcher = container.get<IActionDispatcher>(TYPES.IActionDispatcher);
    host.onmessage = ({ data }: MessageEvent<ToCanvas>) => {
        if (data.type === 'preferences') preferences.update(data.values);
        else if (data.type === 'action') void dispatcher.dispatch(data.action);
    };
    const viewer = container.get<ViewerOptions>(TYPES.ViewerOptions);
    const svgContainer = document.createElement('div');
    svgContainer.id = viewer.baseDiv;
    containerDiv.append(svgContainer);
    const hidden = document.createElement('div');
    hidden.id = viewer.hiddenDiv;
    document.body.append(hidden);
    containerDiv.addEventListener('mouseenter', () => { containerDiv.classList.add('mouse-enter'); containerDiv.classList.remove('mouse-leave'); });
    containerDiv.addEventListener('mouseleave', () => { containerDiv.classList.add('mouse-leave'); containerDiv.classList.remove('mouse-enter'); });
    window.addEventListener('focus', () => void dispatcher.dispatch(FocusStateChangedAction.create(true)));
    window.addEventListener('blur', () => void dispatcher.dispatch(FocusStateChangedAction.create(false)));
    window.addEventListener('contextmenu', e => e.preventDefault());
    container.get(FontPreferences).onStart();
    container.get(EdgePreferences).onStart();
    await container.get(DiagramLoader).load();
    void dispatcher.dispatchOnceModelInitialized(FitToScreenAction.create([], { padding: 40, maxZoom: 1, animate: false }));
}

window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== location.origin || e.data?.type !== 'start') return;
    const [glsp, host] = e.ports;
    void start(e.data as CanvasStartMessage, glsp, host).catch(err => {
        document.body.textContent = `The canvas did not start: ${err instanceof Error ? err.message : String(err)}`;
        console.error(err);
    });
});
