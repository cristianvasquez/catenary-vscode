// Start the GLSP webview canvas from host-provided view and settings data, and wire host notifications and export rendering.
// View edits run on the server; undo, redo and save shortcuts are forwarded to VS Code.
import 'reflect-metadata';
import '@vscode/codicons/dist/codicon.css';
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
import '@eclipse-glsp/client/css/glsp-sprotty.css';
import './canvas.css';
import { ContainerConfiguration, EditMode, FitToScreenAction, IActionDispatcher, TYPES, contextMenuModule, standaloneSelectModule } from '@eclipse-glsp/client';
import { GLSPDiagramIdentifier, GLSPStarter, WebviewGlspClient, vscodeDefaultModule, vscodeNotificationModule } from '@eclipse-glsp/vscode-integration-webview';
import { Container, ContainerModule } from 'inversify';
import { VIEW_SCHEME, INSERT_ELEMENT, OPEN_TEXT } from '../common/protocol';
import { ViewDiagramConfiguration } from './diagram-configuration';
import { EdgePreferences } from './edge-preferences';
import { FontPreferences } from './font-preferences';
import { CANVAS_START, CanvasStart, Preferences, InsertElement, OpenText } from './messages';
import { PasteRdf, OpenIn, DropFiles, OPEN_IN_EVENT, DROP_FILES_EVENT } from './messages';
import { PASTE_RDF_EVENT } from './clipboard';
import { NoteMarkdown } from './note-markdown';
import { CanvasPreferences } from './preferences';
import { HOST_EXTENSION } from 'vscode-messenger-common';
import { SvgExported, HideExportCanvas } from '../common/markdown-export';
import { exportMarkdownSvg } from './markdown-export';

const start = JSON.parse(document.querySelector(`meta[name="${CANVAS_START}"]`)!.getAttribute('content')!) as CanvasStart;
const configuration = new ViewDiagramConfiguration();

class CatenaryStarter extends GLSPStarter {
    protected override createDiagramOptionsModule(identifier: GLSPDiagramIdentifier): ContainerModule {
        const glspClient = new WebviewGlspClient({ id: identifier.diagramType, messenger: this.messenger });
        return configuration.createDiagramOptionsModule({
            clientId: identifier.clientId, diagramType: identifier.diagramType, glspClientProvider: async () => glspClient,
            sourceUri: `${VIEW_SCHEME}:/${start.view}`, editMode: EditMode.EDITABLE
        });
    }

    /**
     * The default and notification modules of the integration. No context menu: the server has no menu provider. Ctrl+A selects all
     * elements (GLSP standaloneSelectModule; Theia: the Select All keybinding of the GLSP integration).
     */
    protected override getContainerConfiguration(): ContainerConfiguration {
        return [{ add: [vscodeDefaultModule, vscodeNotificationModule, standaloneSelectModule], remove: [contextMenuModule] }];
    }

    protected createContainer(...containerConfiguration: ContainerConfiguration): Container {
        const host = new ContainerModule(bind => {
            bind(CanvasPreferences).toSelf().inSingletonScope();
            bind(FontPreferences).toSelf().inSingletonScope();
            bind(EdgePreferences).toSelf().inSingletonScope();
            bind(NoteMarkdown).toSelf().inSingletonScope();
        });
        return configuration.configureContainer(new Container(), ...containerConfiguration, host);
    }

    protected override addVscodeBindings(container: Container): void {
        document.addEventListener(INSERT_ELEMENT, () => { void this.messenger.sendNotification(InsertElement, HOST_EXTENSION, undefined); });
        document.addEventListener(OPEN_TEXT, () => { void this.messenger.sendNotification(OpenText, HOST_EXTENSION, undefined); });
        document.addEventListener(PASTE_RDF_EVENT, e => { void this.messenger.sendNotification(PasteRdf, HOST_EXTENSION, (e as CustomEvent).detail); });
        document.addEventListener(OPEN_IN_EVENT, e => { void this.messenger.sendNotification(OpenIn, HOST_EXTENSION, (e as CustomEvent).detail); });
        document.addEventListener(DROP_FILES_EVENT, e => { void this.messenger.sendNotification(DropFiles, HOST_EXTENSION, (e as CustomEvent).detail); });
        const preferences = container.get(CanvasPreferences);
        preferences.update(start.preferences);
        this.messenger.onNotification(Preferences, values => preferences.update(values));
        container.get(FontPreferences).onStart();
        container.get(EdgePreferences).onStart();
        // A view opened for the first time fits to the screen (ViewEditors.open of the Theia app).
        const dispatcher = container.get<IActionDispatcher>(TYPES.IActionDispatcher);
        void dispatcher.dispatchOnceModelInitialized(FitToScreenAction.create([], { padding: 40, maxZoom: 1, animate: false }));
        void exportMarkdownSvg(container, dispatcher,
            result => { void this.messenger.sendNotification(SvgExported, HOST_EXTENSION, result); },
            token => this.messenger.sendRequest(HideExportCanvas, HOST_EXTENSION, token));
    }
}

new CatenaryStarter();
