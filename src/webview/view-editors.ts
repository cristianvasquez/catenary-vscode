// Expose one canvas's diagram ids, selection, geometry and view controls; adapted from Catenary modeler/src/browser/diagram/view-editors.ts.

import { EditorContextService, GViewportRootElement, IActionDispatcher, TYPES, ViewerOptions } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { viewIdOfUri } from '../common/protocol';
import { DiagramIds, diagramIds } from './diagram-ids';

/** The canvas of this webview, with the fields of the Theia GLSPDiagramWidget that the gestures use. */
@injectable()
export class CanvasWidget {
    @inject(EditorContextService) readonly editorContext: EditorContextService;
    @inject(TYPES.IActionDispatcher) readonly actionDispatcher: IActionDispatcher;
    @inject(TYPES.ViewerOptions) readonly viewerOptions: ViewerOptions;

    /** The base element of the canvas (GLSP mounts the diagram and the tool palette into it). */
    get node(): HTMLElement {
        return document.getElementById(this.viewerOptions.baseDiv)!;
    }
}

@injectable()
export class ViewEditors {
    /** Last diagram ids of each view editor. */
    protected readonly diagrams = new Map<string, { root: unknown; ids: DiagramIds }>();

    /** The ids of the diagram graph of a view editor; undefined before its first model. */
    diagram(w: CanvasWidget): DiagramIds | undefined {
        let root;
        try { root = w.editorContext.modelRoot; } catch { return undefined; }
        const viewId = viewIdOf(w), known = this.diagrams.get(viewId);
        if (known?.root === root) return known.ids;
        const ids = diagramIds(root.index.all() as Iterable<{ id: string; element?: unknown }>);
        this.diagrams.set(viewId, { root, ids });
        return ids;
    }

    /** The element that a diagram id of a view editor shows (a card or a placed edge: its element); other ids stay. */
    elementOf(w: CanvasWidget, id: string): string {
        return this.diagram(w)?.elementOf(id) ?? id;
    }

    /** The diagram id that shows an element in a view editor (its card or edge); other ids stay. */
    placementOf(w: CanvasWidget, id: string): string {
        return this.diagram(w)?.placementOf(id) ?? id;
    }

    /** Client point -> model point of a view editor. */
    toModel(widget: CanvasWidget, clientX: number, clientY: number): { x: number; y: number } {
        const svg = widget.node.querySelector('svg');
        const root = widget.editorContext.modelRoot as unknown as GViewportRootElement;
        const r = svg?.getBoundingClientRect() ?? widget.node.getBoundingClientRect();
        const zoom = root.zoom ?? 1, scroll = root.scroll ?? { x: 0, y: 0 };
        return { x: (clientX - r.left) / zoom + scroll.x, y: (clientY - r.top) / zoom + scroll.y };
    }
}

export function viewIdOf(widget: CanvasWidget): string {
    return viewIdOfUri(widget.editorContext.sourceUri ?? '') ?? '';
}
