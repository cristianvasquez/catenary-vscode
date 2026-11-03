// Bind GLSP view rendering and view-only handlers; adapted from Catenary modeler/src/node/glsp/diagram-module.ts.
// ViewStore owns undo history; handlers return no GLSP command.

import {
    ActionHandlerConstructor, BindingTarget, ClientActionForwarder, DiagramConfiguration, DiagramModule, EdgeTypeHint, GEdge,
    GGraph, GLabel, GModelElementConstructor, GModelFactory, GNode, InstanceMultiBinding, ModelState,
    DefaultModelState, OperationHandlerConstructor, PaletteItem, ServerLayoutKind, ShapeTypeHint, SourceModelStorage, ToolPaletteItemProvider,
    TriggerNodeCreationAction
} from '@eclipse-glsp/server';
import { injectable, interfaces } from 'inversify';
import { TYPES } from '../../catenary/model/diagram-schema';
import { DIAGRAM_TYPE } from '../../common/protocol';
import {
    CanvasEditHandler, ChangeBoundsHandler, CreateGroupHandler, CreateNoteHandler, DeleteHandler, RequestExpandHandler, RequestGestureHandler, SetCardScaleHandler
} from './handlers';
import { RequestEditHandler, RequestMembersHandler } from './handlers';
import { LayoutViewHandler } from './layout';
import { PasteHandler, RequestClipboardDataHandler } from './handlers';
import { RevisionGuardForwarder, ViewGModelFactory, ViewModelStorage, ViewSession, ViewState } from './view-session';

@injectable()
class ViewDiagramConfiguration implements DiagramConfiguration {
    get typeMapping(): Map<string, GModelElementConstructor> {
        return new Map<string, GModelElementConstructor>([
            [TYPES.GRAPH, GGraph],
            [TYPES.CARD, GNode],
            [TYPES.GROUP, GNode],
            [TYPES.NOTE, GNode],
            [TYPES.VIEW_REFERENCE, GNode],
            [TYPES.COLLECTION, GNode],
            [TYPES.RELATION, GEdge],
            [TYPES.BUNDLE, GEdge],
            [TYPES.ARROW, GEdge],
            [TYPES.NAME, GLabel],
            [TYPES.SHAPE, GNode],
            [TYPES.LEAF, GNode],
            [TYPES.ONE_OF, GNode],
            [TYPES.LOGIC, GNode],
            [TYPES.VALUESET, GNode],
            [TYPES.PROPERTY, GEdge],
            [TYPES.ALTERNATIVE, GEdge],
            [TYPES.LATENT, GEdge],
            [TYPES.ROW, GLabel]
        ]);
    }

    get shapeTypeHints(): ShapeTypeHint[] {
        const hint = { repositionable: true, deletable: true, resizable: true, reparentable: false };
        return [
            { elementTypeId: TYPES.CARD, ...hint }, { elementTypeId: TYPES.GROUP, ...hint },
            { elementTypeId: TYPES.NOTE, ...hint }, { elementTypeId: TYPES.VIEW_REFERENCE, ...hint }, { elementTypeId: TYPES.COLLECTION, ...hint },
            { elementTypeId: TYPES.SHAPE, ...hint }, { elementTypeId: TYPES.VALUESET, ...hint }, { elementTypeId: TYPES.ONE_OF, ...hint },
            // Leaf boxes move freely; Del removes their lines too. Logical constraints sit at the middle of their member lines.
            { elementTypeId: TYPES.LEAF, repositionable: true, deletable: true, resizable: false, reparentable: false },
            { elementTypeId: TYPES.LOGIC, repositionable: false, deletable: true, resizable: false, reparentable: false }
        ];
    }

    get edgeTypeHints(): EdgeTypeHint[] {
        return [{
            elementTypeId: TYPES.RELATION, repositionable: false, deletable: true, routable: false,
            sourceElementTypeIds: [TYPES.CARD], targetElementTypeIds: [TYPES.CARD]
        }, {
            elementTypeId: TYPES.BUNDLE, repositionable: false, deletable: false, routable: false,
            sourceElementTypeIds: [TYPES.CARD, TYPES.COLLECTION], targetElementTypeIds: [TYPES.CARD, TYPES.COLLECTION]
        }, {
            elementTypeId: TYPES.ARROW, repositionable: false, deletable: true, routable: false,
            sourceElementTypeIds: [TYPES.CARD, TYPES.GROUP, TYPES.NOTE, TYPES.VIEW_REFERENCE, TYPES.COLLECTION, TYPES.SHAPE, TYPES.LEAF, TYPES.ONE_OF, TYPES.VALUESET],
            targetElementTypeIds: [TYPES.CARD, TYPES.GROUP, TYPES.NOTE, TYPES.VIEW_REFERENCE, TYPES.COLLECTION, TYPES.SHAPE, TYPES.LEAF, TYPES.ONE_OF, TYPES.VALUESET]
        }, {
            elementTypeId: TYPES.PROPERTY, repositionable: false, deletable: true, routable: false,
            sourceElementTypeIds: [TYPES.SHAPE], targetElementTypeIds: [TYPES.SHAPE, TYPES.LEAF, TYPES.ONE_OF, TYPES.VALUESET]
        }, {
            elementTypeId: TYPES.ALTERNATIVE, repositionable: false, deletable: false, routable: false,
            sourceElementTypeIds: [TYPES.ONE_OF], targetElementTypeIds: [TYPES.SHAPE, TYPES.VALUESET, TYPES.LEAF]
        }];
    }

    /** No server layout: positions come from the view graph. */
    layoutKind = ServerLayoutKind.MANUAL;
    needsClientLayout = false;
    animatedUpdate = false;
}

/** Server palette: Group and Note view marks only. The client adds Insert and Layout; no palette item creates model data. */
@injectable()
class ShapesPaletteProvider extends ToolPaletteItemProvider {
    getItems(): PaletteItem[] {
        return [
            {
                id: 'layout', label: 'View', sortString: 'B', actions: [], icon: 'layout', children: [
                    { id: 'group', label: 'Group', sortString: 'A', icon: 'symbol-namespace', actions: [TriggerNodeCreationAction.create(TYPES.GROUP)] },
                    { id: 'note', label: 'Note', sortString: 'B', icon: 'note', actions: [TriggerNodeCreationAction.create(TYPES.NOTE)] }
                ]
            }
        ];
    }
}

@injectable()
export class ViewDiagramModule extends DiagramModule {
    readonly diagramType = DIAGRAM_TYPE;

    protected override configure(bind: interfaces.Bind, unbind: interfaces.Unbind, isBound: interfaces.IsBound, rebind: interfaces.Rebind): void {
        super.configure(bind, unbind, isBound, rebind);
        bind(ViewState).toSelf().inSingletonScope();
        bind(ViewSession).toSelf().inSingletonScope();
    }

    protected bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> { return ViewDiagramConfiguration; }
    protected bindSourceModelStorage(): BindingTarget<SourceModelStorage> { return ViewModelStorage; }
    protected bindModelState(): BindingTarget<ModelState> { return DefaultModelState; }
    protected bindGModelFactory(): BindingTarget<GModelFactory> { return ViewGModelFactory; }
    protected override bindToolPaletteItemProvider(): BindingTarget<ToolPaletteItemProvider> { return ShapesPaletteProvider; }
    protected override bindClientActionForwarder(): BindingTarget<ClientActionForwarder> { return RevisionGuardForwarder; }

    protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
        super.configureActionHandlers(binding);
        binding.add(SetCardScaleHandler);
        binding.add(CanvasEditHandler);
        binding.add(RequestExpandHandler);
        binding.add(RequestGestureHandler);
        binding.add(RequestMembersHandler);
        binding.add(RequestEditHandler);
        binding.add(LayoutViewHandler);
        binding.add(RequestClipboardDataHandler);
    }

    protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
        super.configureOperationHandlers(binding);
        binding.add(CreateGroupHandler);
        binding.add(CreateNoteHandler);
        binding.add(ChangeBoundsHandler);
        binding.add(DeleteHandler);
        binding.add(PasteHandler);
    }
}
