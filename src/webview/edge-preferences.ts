// Apply shared edge-style and vocabulary-color preferences and redraw the canvas; adapted from Catenary modeler/src/browser/diagram/edge-preferences.ts.

import { EditorContextService, Emitter, IActionDispatcher, SetViewportAction, TYPES, isViewport } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { EDGE_STYLES, EdgeStyle } from './edge-route';
import { CanvasPreferences } from './preferences';
import { VOCABULARY_COLORS, VOCABULARY_COLOR_DEFAULT, VocabularyColor, setVocabularyColor } from './vocabulary-color';

const EDGE_STYLE = 'catenary.edgeStyle';
const EDGE_STYLE_DEFAULT: EdgeStyle = 'curved';
const VOCABULARY_COLOR = 'catenary.vocabularyColor';

let current: EdgeStyle = EDGE_STYLE_DEFAULT;
/** The edge style that the edge views draw with. */
export const edgeStyle = (): EdgeStyle => current;

@injectable()
export class EdgePreferences {
    @inject(CanvasPreferences) protected readonly preferences!: CanvasPreferences;
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;
    @inject(EditorContextService) protected readonly editorContext!: EditorContextService;
    protected readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;

    onStart(): void {
        current = this.get();
        setVocabularyColor(this.vocabulary());
        this.preferences.onDidChange(names => {
            if (!names.includes(EDGE_STYLE) && !names.includes(VOCABULARY_COLOR)) return;
            current = this.get();
            setVocabularyColor(this.vocabulary());
            this.redraw();
            this.changed.fire();
        });
    }

    get(): EdgeStyle {
        const v = this.preferences.get(EDGE_STYLE, EDGE_STYLE_DEFAULT);
        return (EDGE_STYLES as readonly unknown[]).includes(v) ? v as EdgeStyle : EDGE_STYLE_DEFAULT;
    }

    vocabulary(): VocabularyColor {
        const v = this.preferences.get(VOCABULARY_COLOR, VOCABULARY_COLOR_DEFAULT);
        return (VOCABULARY_COLORS as readonly unknown[]).includes(v) ? v as VocabularyColor : VOCABULARY_COLOR_DEFAULT;
    }

    /** A viewport action with the same viewport makes GLSP render the diagram again. */
    protected redraw(): void {
        let root;
        try { root = this.editorContext.modelRoot; } catch { return; }
        if (isViewport(root)) void this.dispatcher.dispatch(SetViewportAction.create(root.id, { scroll: root.scroll, zoom: root.zoom }, { animate: false }));
    }
}
