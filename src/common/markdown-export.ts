// Shared messages and metadata for Markdown SVG export between the host and the temporary canvas.
import type { NotificationType, RequestType } from 'vscode-messenger-common';

export interface SvgResult { token: string; svg?: string; error?: string }
export const SvgExported: NotificationType<SvgResult> = { method: 'catenary/markdownSvg' };
export const EXPORT_META = 'catenary-export';
export const HideExportCanvas: RequestType<string, void> = { method: 'catenary/hideExportCanvas' };
