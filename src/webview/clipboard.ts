// Handle DOM copy, cut and paste; adapted from Catenary modeler/src/browser/diagram/clipboard.ts and diagram-configuration.ts.
// The server shares clip tokens across canvases; non-token text goes to the host as RDF with the paste point.

import {
    ICopyPasteHandler, IDiagramStartup, PasteOperation, RequestClipboardDataAction, ServerCopyPasteHandler, TYPES, generateUuid
} from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { VIEW_CLIP_FORMAT } from '../catenary/model/commands';
import { viewIdOfUri } from '../common/protocol';
import { clipIdOf, clipToken, rdfOf } from './clip-transport';

/** The DOM event of a paste of RDF text: the main module sends it to the extension host (PasteRdf). */
import { PASTE_RDF as PASTE_RDF_EVENT } from '../common/protocol';
export { PASTE_RDF as PASTE_RDF_EVENT } from '../common/protocol';

/**
 * Copy, cut and paste while any element of the view editor has the focus. GLSP accepts only an element
 * whose parent is the base div; a click on empty canvas focuses the svg one level deeper, and the paste was ignored.
 * A paste places the same elements. A cut requests the clip with `args.mode = 'cut'`: the paste of that clip moves the elements
 * without copying model statements. The server replies to a paste with its counts in the status of the canvas.
 */
@injectable()
export class ViewCopyPasteHandler extends ServerCopyPasteHandler {
    /** Paste order: the custom type, then a text/plain token, then RDF. */
    override handlePaste(event: ClipboardEvent): void {
        if (!event.clipboardData || !this.shouldPaste(event)) return;
        const data = event.clipboardData, types = [...data.types], get = (type: string) => data.getData(type);
        event.preventDefault();
        const id = clipIdOf(types, get);
        if (id) return this.pasteClip(id);
        const view = viewIdOfUri(this.editorContext.sourceUri ?? '');
        if (!view) return;
        const { text, mediaType } = rdfOf(types, get), at = this.editorContext.get().lastMousePosition;
        if (text.trim()) document.dispatchEvent(new CustomEvent(PASTE_RDF_EVENT, { detail: { text, mediaType, at } }));
    }

    /** Reference paste of a clip: the clip of this canvas, else the id only (the server has the last clip of the folder). */
    protected pasteClip(clipboardId: string): void {
        const clipboardData = { clipboardId, ...this.clipboardService.get(clipboardId) };
        this.actionDispatcher.dispatch(PasteOperation.create({ clipboardData, editorContext: this.editorContext.get() }));
    }

    /** Copy: the GLSP selection of this canvas (Catenary: canvasKeyTargets with the window highlight). */
    protected keyTargets(): string[] {
        return this.editorContext.get().selectedElementIds;
    }

    override handleCopy(event: ClipboardEvent): void {
        const ids = this.keyTargets();
        if (!event.clipboardData || !ids.length || !this.hasFocus()) {
            event.clipboardData?.clearData();
            this.clipboardService.clear();
            return;
        }
        const clipboardId = generateUuid();
        event.clipboardData.setData('text/plain', clipToken(clipboardId));
        event.clipboardData.setData(VIEW_CLIP_FORMAT, clipToken(clipboardId));
        void this.actionDispatcher.request(RequestClipboardDataAction.create({ ...this.editorContext.get({ clipboardId }), selectedElementIds: ids }))
            .then(action => this.clipboardService.put(action.clipboardData, clipboardId));
        event.preventDefault();
    }

    /** Cut sends no edit: the paste moves the elements. */
    override handleCut(event: ClipboardEvent): void {
        const view = viewIdOfUri(this.editorContext.sourceUri ?? '');
        if (!event.clipboardData || !view || !this.shouldCopy(event)) return;
        const clipboardId = generateUuid();
        event.clipboardData.setData('text/plain', clipToken(clipboardId));
        event.clipboardData.setData(VIEW_CLIP_FORMAT, clipToken(clipboardId));
        void this.actionDispatcher.request(RequestClipboardDataAction.create(this.editorContext.get({ mode: 'cut', clipboardId })))
            .then(action => this.clipboardService.put({ ...action.clipboardData, clipboardId }, clipboardId));
        event.preventDefault();
    }

    /** Cut: the GLSP selection of this canvas. */
    protected override shouldCopy(_event: ClipboardEvent): boolean {
        return this.keyTargets().length > 0 && this.hasFocus();
    }

    protected override shouldPaste(_event: ClipboardEvent): boolean {
        return this.hasFocus();
    }

    protected hasFocus(): boolean {
        return !!document.getElementById(this.viewerOptions.baseDiv)?.contains(document.activeElement);
    }
}

/** The copy, cut and paste events of the webview go to the copy-paste handler of the canvas (Catenary: Theia FrontendApplicationContribution). */
@injectable()
export class ViewClipboard implements IDiagramStartup {
    @inject(TYPES.ICopyPasteHandler) protected readonly handler: ICopyPasteHandler;

    preInitialize(): void {
        document.addEventListener('copy', e => this.handler.handleCopy(e));
        document.addEventListener('cut', e => this.handler.handleCut(e));
        document.addEventListener('paste', e => this.handler.handlePaste(e));
    }
}
