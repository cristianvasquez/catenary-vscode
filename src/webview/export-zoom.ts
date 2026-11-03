// Preserve canvas zoom proportions in SVG export; adapted from Catenary modeler/src/browser/diagram/export-zoom.ts.
// Screen-sized labels, badges and arrows use the live canvas zoom while geometry stays in model units.

import { CommandExecutionContext, CommandResult, RequestExportAction, RequestExportCommand, TYPES, isViewport } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';

/** A root of the export canvas: `canvasZoom` is the zoom of the live canvas when the export started. */
export interface ZoomedRoot { zoom?: number; canvasZoom?: number }

/** The zoom for sizes that are constant on screen: the canvas zoom of an export root, else the zoom of the root, else 1. */
export function sizeZoom(root: ZoomedRoot): number {
    const zoom = root.canvasZoom ?? root.zoom;
    return zoom && zoom > 0 ? zoom : 1;
}

/** The GLSP export command (zoom 1, no selection) that also gives the export root the zoom of the live canvas. */
@injectable()
export class CanvasZoomExportCommand extends RequestExportCommand {
    constructor(@inject(TYPES.Action) action: RequestExportAction) {
        super(action);
    }

    override execute(context: CommandExecutionContext): CommandResult {
        const result = super.execute(context);
        if (result.model !== context.root && isViewport(context.root)) (result.model as ZoomedRoot).canvasZoom = context.root.zoom;
        return result;
    }
}
