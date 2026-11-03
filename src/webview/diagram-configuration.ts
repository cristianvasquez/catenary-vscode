// Bind one webview's GLSP canvas services and view-only tools; adapted from Catenary modeler/src/browser/diagram/diagram-configuration.ts.
// Includes clipboard, note and group editors, Insert, Layout and SVG export; excludes model-edit tools.

import {
    ConsoleLogger, ContainerConfiguration, DefaultTypes, FeatureModule, GGraph, GLabel, GResizeHandle, LogLevel, TYPES, bindOrRebind,
    configureModelElement, configureView, KeyboardToolPalette, gridModule, configureActionHandler, Action, CursorCSS, EnableToolsAction,
    GModelElement, KeyListener, MarqueeMouseListener, MarqueeMouseTool, MarqueeTool, cursorFeedbackAction, helperLineModule,
    initializeDiagramContainer, accessibilityModule, toolPaletteModule, FocusTrackerTool, PaletteItem, ChangeBoundsOperation,
    CompoundOperation, CreateNodeOperation, configureCommand, createDiagramOptionsModule, IDiagramOptions
} from '@eclipse-glsp/client';
import { Container, injectable } from 'inversify';
import { inject } from 'inversify';
import { NoteEditor } from './note-editor';
import { TYPES as CATENARY, ownerOfLabel } from '../catenary/model/diagram-schema';
import { DIAGRAM_TYPE, INSERT_ELEMENT, OPEN_TEXT } from '../common/protocol';
import { ModelActions } from './actions';
import { CanvasInteractions } from './canvas';
import { CardScaleStartup } from './card-scale';
import { ViewClipboard, ViewCopyPasteHandler } from './clipboard';
import { bindMarkdownExport } from './markdown-export';
import { ModelFrontend } from './model-client';
import { ApplyPendingBoundsCommand, PendingBounds } from './pending-bounds';
import { CanvasWidget, ViewEditors } from './view-editors';
import {
    AlternativeEdge, AlternativeEdgeView, LatentEdge, LatentEdgeView, ArrowEdge, ArrowEdgeView, BundleEdge, BundleEdgeView, CardNode, CardView, CollectionNode, CollectionView, GroupNode, GroupView, LeafNode, LeafView, LogicNode, LogicView, NameLabelView, OneOfNode, OneOfView,
    NoteNode, NoteView, PropertyEdge, PropertyEdgeView, RelationEdge, RelationEdgeView, ResizeHandleView, ShapeCardView, ShapeNode, ShapeRow, ShapeRowView, ValueSetNode, ValueSetView,
    CatenaryGraphView, ViewReferenceNode, ViewReferenceView
} from './views';

const viewDiagramModule = new FeatureModule((bind, unbind, isBound, rebind) => {
    const context = { bind, unbind, isBound, rebind };
    bindOrRebind(context, TYPES.ILogger).to(ConsoleLogger).inSingletonScope();
    bindOrRebind(context, TYPES.LogLevel).toConstantValue(LogLevel.warn);
    bind(CardScaleStartup).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(CardScaleStartup);
    configureModelElement(context, DefaultTypes.GRAPH, GGraph, CatenaryGraphView);
    configureModelElement(context, CATENARY.CARD, CardNode, CardView);
    configureModelElement(context, CATENARY.GROUP, GroupNode, GroupView);
    configureModelElement(context, CATENARY.NOTE, NoteNode, NoteView);
    configureModelElement(context, CATENARY.VIEW_REFERENCE, ViewReferenceNode, ViewReferenceView);
    configureModelElement(context, CATENARY.RELATION, RelationEdge, RelationEdgeView);
    configureModelElement(context, CATENARY.COLLECTION, CollectionNode, CollectionView);
    configureModelElement(context, CATENARY.BUNDLE, BundleEdge, BundleEdgeView);
    configureModelElement(context, CATENARY.ARROW, ArrowEdge, ArrowEdgeView);
    configureModelElement(context, CATENARY.NAME, GLabel, NameLabelView);
    configureModelElement(context, CATENARY.SHAPE, ShapeNode, ShapeCardView);
    configureModelElement(context, CATENARY.ROW, ShapeRow, ShapeRowView);
    configureModelElement(context, CATENARY.PROPERTY, PropertyEdge, PropertyEdgeView);
    configureModelElement(context, CATENARY.LEAF, LeafNode, LeafView);
    configureModelElement(context, CATENARY.ONE_OF, OneOfNode, OneOfView);
    configureModelElement(context, CATENARY.ALTERNATIVE, AlternativeEdge, AlternativeEdgeView);
    configureModelElement(context, CATENARY.LATENT, LatentEdge, LatentEdgeView);
    configureModelElement(context, CATENARY.LOGIC, LogicNode, LogicView);
    configureModelElement(context, CATENARY.VALUESET, ValueSetNode, ValueSetView);
    configureView(context, GResizeHandle.TYPE, ResizeHandleView, true);
    bindMarkdownExport(rebind);
    // VS Code glue: the canvas gestures (canvas.ts) and the services that replace the Theia frontend (view-editors.ts, model-client.ts, actions.ts).
    bind(CanvasWidget).toSelf().inSingletonScope();
    bind(ViewEditors).toSelf().inSingletonScope();
    bind(ModelFrontend).toSelf().inSingletonScope();
    bind(ModelActions).toSelf().inSingletonScope();
    bind(CanvasInteractions).toSelf().inSingletonScope();
    bind(NoteEditor).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(CanvasInteractions);
    // A server update sent before the server applied the last drop does not draw the box at its older place (pending-bounds.ts).
    bind(PendingBounds).toSelf().inSingletonScope();
    configureActionHandler(context, ChangeBoundsOperation.KIND, PendingBounds);
    configureActionHandler(context, CompoundOperation.KIND, PendingBounds);
    configureCommand(context, ApplyPendingBoundsCommand);
    // Copy, cut and paste on the canvas (clipboard.ts).
    bindOrRebind(context, TYPES.ICopyPasteHandler).to(ViewCopyPasteHandler);
    bind(ViewClipboard).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(ViewClipboard);
}, { featureId: Symbol('viewDiagram') });

/**
 * Shift+drag on the canvas: marquee that adds to the selection. GLSP enables the marquee only when nothing is selected,
 * and keeps the previous selection only with Ctrl.
 */
class ShiftMarqueeKeyListener extends KeyListener {
    override keyDown(_element: GModelElement, event: KeyboardEvent): Action[] {
        return event.shiftKey ? [EnableToolsAction.create([MarqueeMouseTool.ID])] : [];
    }
}

@injectable()
class AddingMarqueeTool extends MarqueeTool {
    override enable(): void {
        this.toDisposeOnDisable.push(this.keyTool.registerListener(new ShiftMarqueeKeyListener()));
    }
}

class AddingMarqueeMouseListener extends MarqueeMouseListener {
    override mouseDown(target: GModelElement, event: MouseEvent): Action[] {
        const result = super.mouseDown(target, event);
        this.previouslySelected = [...target.root.index.all()].filter(e => (e as { selected?: boolean }).selected).map(e => e.id);
        return result;
    }
}

@injectable()
class AddingMarqueeMouseTool extends MarqueeMouseTool {
    /** As the base class, with AddingMarqueeMouseListener. */
    override enable(): void {
        this.toDisposeOnDisable.push(
            this.mouseTool.registerListener(new AddingMarqueeMouseListener(this.editorContext.modelRoot, this.marqueeUtil)),
            this.keyTool.registerListener(this.shiftKeyListener),
            this.createFeedbackEmitter().add(cursorFeedbackAction(CursorCSS.MARQUEE), cursorFeedbackAction()).submit()
        );
    }
}

const marqueeModule = new FeatureModule((_bind, _unbind, _isBound, rebind) => {
    rebind(MarqueeTool).to(AddingMarqueeTool).inSingletonScope();
    rebind(MarqueeMouseTool).to(AddingMarqueeMouseTool).inSingletonScope();
}, { featureId: Symbol('marquee') });

/** One toolbar above the canvas: Insert, Group, Note, Layout, TriG. Group and Note come from ShapesPaletteProvider. */
@injectable()
class CatenaryToolPalette extends KeyboardToolPalette {
    @inject(ModelActions) protected readonly actions: ModelActions;

    /** No header tools: no delete tool (Del), no search (Ctrl+T). The selection button stays as the "clicked" target when the default tools are active. */
    protected override createHeaderTools(): HTMLElement {
        this.headerToolsButtonMapping.clear();
        const headerTools = document.createElement('div');
        headerTools.classList.add('catenary-tools');
        const insert = document.createElement('button');
        insert.classList.add('catenary-tool');
        insert.innerHTML = '<span class="codicon codicon-search"></span><span>Insert</span>';
        insert.dataset.item = 'insert';
        insert.title = 'Insert elements from the workspace';
        insert.onclick = () => document.dispatchEvent(new Event(INSERT_ELEMENT));
        headerTools.append(insert);
        // Apply Layout (Catenary: a view editor command with a quick pick): a picker of the algorithms below the button.
        const layout = document.createElement('button');
        layout.classList.add('catenary-tool');
        layout.innerHTML = '<span class="codicon codicon-type-hierarchy-sub"></span><span>Layout</span>';
        layout.dataset.item = 'apply-layout';
        layout.title = 'Apply Layout';
        layout.onclick = () => { const r = layout.getBoundingClientRect(); void this.actions.layoutView({ x: r.left, y: r.bottom + 4 }); };
        headerTools.append(layout);
        const text = document.createElement('button');
        text.classList.add('catenary-tool');
        text.innerHTML = '<span class="codicon codicon-file-code"></span><span>TriG</span>';
        text.dataset.item = 'open-text';
        text.title = 'Open the view file as TriG text';
        text.style.marginLeft = 'auto';
        text.onclick = () => document.dispatchEvent(new Event(OPEN_TEXT));
        headerTools.append(text);
        this.defaultToolsButton = this.createDefaultToolButton();
        this.headerToolsButtonMapping.set(0, this.defaultToolsButton);
        return headerTools;
    }

    protected override createKeyboardToolButton(item: PaletteItem, tabIndex: number, buttonIndex: number): HTMLElement {
        const button = super.createKeyboardToolButton(item, tabIndex, buttonIndex);
        button.dataset.item = item.id;
        button.classList.add('catenary-tool');
        button.setAttribute('role', 'button');
        const shortcut = button.querySelector('.key-shortcut');
        if (item.id === 'group') button.innerHTML = '<span class="codicon codicon-symbol-namespace"></span><span>Group</span>';
        if (item.id === 'note') button.innerHTML = '<span class="codicon codicon-note"></span><span>Note</span>';
        if (shortcut) button.append(shortcut);
        return button;
    }

    /** Move the GLSP tools by reference so their keyboard mappings and handlers stay intact. */
    protected override createBody(): void {
        super.createBody();
        const body = this.bodyDiv!;
        const tools = ['group', 'note'].map(id => body.querySelector<HTMLElement>(`[data-item="${id}"]`));
        const toolbar = this.containerElement.querySelector<HTMLElement>('.catenary-tools')!;
        toolbar.querySelectorAll('.tool-button').forEach(button => button.remove());
        const layout = toolbar.querySelector('[data-item="apply-layout"]');
        for (const button of tools) if (button) toolbar.insertBefore(button, layout);
        body.replaceChildren();
    }

    protected override onClickCreateToolButton(button: HTMLElement, item: PaletteItem): (ev: MouseEvent) => void {
        const arm = super.onClickCreateToolButton(button, item);
        return ev => {
            // Group with boxes selected on this canvas: a group around them at once (no click on the canvas). VS Code glue: Catenary ran
            // the command New Group; here the create operation names the boxes (CreateGroupHandler).
            const around = item.id === 'group' ? this.boxesSelected() : [];
            if (around.length) return void this.actionDispatcher.dispatch(CreateNodeOperation.create(CATENARY.GROUP, { args: { around: around.join('\n') } }));
            arm(ev);
        };
    }

    /** The boxes of the selection of this canvas (card, group, note, reference, collection, node shape, value set): their element ids. */
    protected boxesSelected(): string[] {
        const boxes: string[] = [CATENARY.CARD, CATENARY.GROUP, CATENARY.NOTE, CATENARY.VIEW_REFERENCE, CATENARY.COLLECTION, CATENARY.SHAPE, CATENARY.VALUESET];
        return this.editorContext.selectedElements.filter(e => boxes.includes(e.type))
            .map(e => ownerOfLabel((e as { element?: string }).element || e.id));
    }
}

/** The GLSP focus tracker shows a "Currently focused: …" toast on each focus change. No listeners, no toast. */
@injectable()
class SilentFocusTracker extends FocusTrackerTool {
    override enable(): void { /* disabled */ }
}

const catenaryToolPaletteModule = new FeatureModule((_bind, _unbind, _isBound, rebind) => {
    rebind(KeyboardToolPalette).to(CatenaryToolPalette).inSingletonScope();
    rebind(FocusTrackerTool).to(SilentFocusTracker).inSingletonScope();
}, { featureId: Symbol('toolPalette'), requires: accessibilityModule });

@injectable()
export class ViewDiagramConfiguration {
    diagramType = DIAGRAM_TYPE;

    /** No zoom-out limit (GLSP: 0.1), so that a fit shows a large view. 0.001: a zoom of 0 has no scale. The zoom-in limit stays. */
    createDiagramOptionsModule(options: IDiagramOptions): FeatureModule {
        return createDiagramOptionsModule(options, { zoomLimits: { min: 0.001, max: 20 } });
    }

    configureContainer(container: Container, ...containerConfiguration: ContainerConfiguration): Container {
        // accessibilityModule brings a keyboard-aware tool palette that replaces the default one.
        return initializeDiagramContainer(container, helperLineModule, gridModule, viewDiagramModule, ...containerConfiguration,
            { add: [accessibilityModule, catenaryToolPaletteModule, marqueeModule], remove: [toolPaletteModule] });
    }
}
