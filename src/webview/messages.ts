// Host/webview notifications for settings, insertion, RDF paste, source navigation and file drops, plus canvas startup data.
// GLSP carries diagram reads and view edits separately.
import type { NotificationType } from 'vscode-messenger-common';
import type { PreferenceValues } from './preferences';
import { INSERT_ELEMENT, OPEN_TEXT, PASTE_RDF, PREFERENCES, OPEN_IN_EVENT, DROP_FILES_EVENT } from '../common/protocol';
export { OPEN_IN_EVENT, DROP_FILES_EVENT } from '../common/protocol';

/** Host to webview: the catenary.* settings after a change. */
export const InsertElement: NotificationType<void> = { method: INSERT_ELEMENT };
/** Webview to host: reopen this canvas as TriG text. */
export const OpenText: NotificationType<void> = { method: OPEN_TEXT };
/** Webview to host: RDF text pasted on the canvas, with the paste point in diagram coordinates (vscode/paste-rdf.ts). */
export const PasteRdf: NotificationType<{ text: string; mediaType?: string; at?: { x: number; y: number } }> = { method: PASTE_RDF };
export const Preferences: NotificationType<PreferenceValues> = { method: PREFERENCES };
/** Webview to host: open what an element shows: a view (its id), a file reference (path relative to the view file), or a model element at its statement. */
export const OpenIn: NotificationType<{ view?: string; file?: string; element?: string; problem?: string }> = { method: OPEN_IN_EVENT };
/** Webview to host: files dropped on the canvas (URIs), with the drop point in diagram coordinates: a view file is a view reference, another file a file reference. */
export const DropFiles: NotificationType<{ uris: string[]; at: { x: number; y: number } }> = { method: DROP_FILES_EVENT };

/** The start data of the page (a meta element): the view id of the editor and the settings. */
export interface CanvasStart {
    view: string;
    preferences: PreferenceValues;
}
export const CANVAS_START = 'catenary-canvas';
