// Initialize and fit the export canvas, request GLSP SVG and convert measured text; adapted from Catenary modeler/src/browser/diagram/markdown-export.ts.
import { FitToScreenAction, GLSPSvgExporter, IActionDispatcher, RequestExportAction, RequestExportCommand } from '@eclipse-glsp/client';
import type { Container } from 'inversify';
import { EXPORT_META, type SvgResult } from '../common/markdown-export';
import { CanvasZoomExportCommand } from './export-zoom';
import { forDocument } from './markdown-svg';
import { MeasuringSvgExporter, withDrawnFont } from './text-measure';

export function bindMarkdownExport(rebind: Container['rebind']): void {
    rebind(RequestExportCommand).to(CanvasZoomExportCommand);
    rebind(GLSPSvgExporter).to(MeasuringSvgExporter).inSingletonScope();
}

export async function exportMarkdownSvg(container: Container, dispatcher: IActionDispatcher, send: (result: SvgResult) => void, hide: (token: string) => Promise<void>): Promise<void> {
    const token = document.querySelector(`meta[name="${EXPORT_META}"]`)?.getAttribute('content');
    if (!token) return;
    try {
        await dispatcher.onceModelInitialized();
        await document.fonts.ready;
        await dispatcher.dispatch(FitToScreenAction.create([], { padding: 40, maxZoom: 1, animate: false }));
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await hide(token);
        const result = await dispatcher.request(RequestExportAction.create('svg'));
        const exporter = container.get<MeasuringSvgExporter>(GLSPSvgExporter);
        send({ token, svg: forDocument(result.data, exporter.lines, withDrawnFont) });
    } catch (error) {
        send({ token, error: error instanceof Error ? error.message : String(error) });
    }
}
