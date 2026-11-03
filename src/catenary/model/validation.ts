// JSON validation result records populated from turtle-lsp diagnostics; adapted from Catenary packages/model/src/validation.ts.

export interface Violation {
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    instance?: string;           // instance id, if the focus node is an instance
    focus: string;               // focus node IRI
    path?: string;               // predicate IRI (simple paths only)
    shape?: string;              // property shape id of the source shape, if it is one
    pathName?: string;
    severity: 'Violation' | 'Warning' | 'Info';
    component: string;           // local name of the constraint component
    message: string;
}

