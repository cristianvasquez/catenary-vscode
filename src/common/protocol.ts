// Protocol constants between the view editor and its GLSP server session.

import type { Action, RequestAction, ResponseAction } from '@eclipse-glsp/protocol';
import type { ViewCommand } from '../catenary/model/commands';
import type { Choices } from '../catenary/model/prompts';
import type { GestureInfo, ViewGesture } from '../catenary/model/view-ui';

/** GLSP diagram type of the view editor. */
export const DIAGRAM_TYPE = 'catenary-view';

export const SET_CARD_SCALE = 'catenarySetCardScale';
export interface SetCardScaleAction extends Action { kind: typeof SET_CARD_SCALE; scale: number }
export const LAYOUT_VIEW = 'catenaryLayoutView';
export interface LayoutViewAction extends Action { kind: typeof LAYOUT_VIEW; algorithm?: LayoutAlgorithm; spacing?: number }
export const INSERT_ELEMENT = 'catenaryInsertElement';
export const OPEN_TEXT = 'catenaryOpenText';
export const PASTE_RDF = 'catenaryPasteRdf';
export const PREFERENCES = 'catenaryPreferences';
export const OPEN_IN_EVENT = 'catenaryOpenIn';
export const DROP_FILES_EVENT = 'catenaryDropFiles';
export const APPLY_PENDING_BOUNDS = 'catenaryApplyPendingBounds';

/** GLSP session URI: catenary-view:/<view id>; the custom editor persists the view in a .trig file. */
export const VIEW_SCHEME = 'catenary-view';

export function viewIdOfUri(uri: string): string | undefined {
    const m = /^catenary-view:\/+([^?#/]+)/.exec(uri) ?? /^\/+([^?#/]+)$/.exec(uri);
    return m?.[1];
}

// VS Code glue: the edits and reads of the canvas gestures go over GLSP actions to the session of the view (src/node/glsp/handlers.ts).
// They replace Catenary's ModelFrontend RPC (execute, viewGesture, neighborChoices, shapeSourceChoices).

/** One ViewCommand of a canvas gesture. `select`: the ids to select after the edit; 'result': the ids that the edit made. */
export interface CanvasEditAction extends Action {
    kind: typeof CANVAS_EDIT;
    command: ViewCommand;
    select?: string[] | 'result';
}
export const CANVAS_EDIT = 'catenaryEdit';

/** Request: the answer of the backend for a gesture (GestureAnswer). */
export const REQUEST_GESTURE = 'catenaryRequestGesture';
export interface RequestGestureAction extends RequestAction<GestureAnswerAction> { kind: typeof REQUEST_GESTURE; gesture: ViewGesture }
export const GESTURE_ANSWER = 'catenaryGestureAnswer';
export interface GestureAnswerAction extends ResponseAction { kind: typeof GESTURE_ANSWER; info: GestureInfo }

/** Request: the choices of a halo expand button (ExpandChoices). */
export const REQUEST_EXPAND = 'catenaryRequestExpand';
export interface RequestExpandAction extends RequestAction<ExpandChoicesAction> { kind: typeof REQUEST_EXPAND; from: string; dir: 'in' | 'out' | 'targets' }
export const EXPAND_CHOICES = 'catenaryExpandChoices';
export interface ExpandChoicesAction extends ResponseAction { kind: typeof EXPAND_CHOICES; choices?: Choices }

/** Request: the "+ member" reads of an entity group (Catenary RPC memberOptions, instancesNamed): `text` absent, the labels of the
 * instances that are not members of `collection`; `text`: the ids of the instances with that label or IRI. */
export const REQUEST_MEMBERS = 'catenaryRequestMembers';
export interface RequestMembersAction extends RequestAction<MemberChoicesAction> { kind: typeof REQUEST_MEMBERS; collection: string; text?: string }
export const MEMBER_CHOICES = 'catenaryMemberChoices';
export interface MemberChoicesAction extends ResponseAction { kind: typeof MEMBER_CHOICES; values: string[] }

/** Apply Layout supports ELK layered (left to right) and cola.js force-directed layout; node/glsp/layout.ts runs them. */
export const LAYOUT_ALGORITHMS = [
    { id: 'layered', label: 'Layered', description: 'left to right, order with fewer edge crossings (ELK)' },
    { id: 'force', label: 'Force', description: 'force-directed (cola.js)' }
] as const;
export type LayoutAlgorithm = typeof LAYOUT_ALGORITHMS[number]['id'];
/** Space between boxes (px) of Apply Layout. VS Code glue: the default only (Catenary: the user preference `catenary.layoutSpacing`). */
export const LAYOUT_SPACING = { default: 200, min: 20, max: 400 } as const;
/** A spacing in range; else the default. */
export function layoutSpacing(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(LAYOUT_SPACING.max, Math.max(LAYOUT_SPACING.min, Math.round(n))) : LAYOUT_SPACING.default;
}

/** Request: one ViewCommand and the result of the store (EditResult). The note editor keeps its draft when the store refuses the edit. */
export const REQUEST_EDIT = 'catenaryRequestEdit';
export interface RequestEditAction extends RequestAction<EditResultAction> { kind: typeof REQUEST_EDIT; command: ViewCommand }
export const EDIT_RESULT = 'catenaryEditResult';
export interface EditResultAction extends ResponseAction { kind: typeof EDIT_RESULT; result: { ok: true } | { ok: false; error: string } }
