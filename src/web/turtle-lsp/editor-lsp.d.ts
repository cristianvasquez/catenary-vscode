// Types of the turtle-lsp browser editor module (web/app/editor-lsp.js, MIT), which the web build copies next to the page
// (scripts/build-web.mjs, from the turtle-lsp fork) and loads at run time. Only the members that the page uses.

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDiagnostic {
    range: LspRange;
    severity?: number;
    code?: string | number;
    source?: string;
    message: string;
    relatedInformation?: { location: { uri: string; range: LspRange }; message: string }[];
}

export class LspClient {
    constructor(url: string | URL);
    on(name: 'diagnostics', f: (uri: string, list: LspDiagnostic[]) => void): void;
    on(name: 'serverRequest', f: (method: string, params: unknown) => void): void;
    on(name: 'crash', f: (message: string, info: { state: string; dropped?: string[] }) => void): void;
    on(name: 'busy', f: (busy: boolean) => void): void;
    initialize(params: unknown): Promise<{ capabilities: Record<string, unknown> }>;
    request(method: string, params: unknown, token?: unknown): Promise<unknown>;
    notify(method: string, params: unknown): void;
}

export function connect(monaco: unknown, client: LspClient, capabilities: unknown, diagnosticsOf: (uri: string) => LspDiagnostic[]): { refresh(method: string): void; shown(): void };
export function markers(monaco: unknown, list: LspDiagnostic[]): unknown[];
export function registerSyntax(monaco: unknown): void;
export function languageOf(path: string): string;
export function quietJson(monaco: unknown): void;
