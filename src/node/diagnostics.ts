// Map turtle-lsp diagnostic ranges to violation records on the old graph (the browser page until K13). The mapping: read/diagnostics.ts.
import type { Diagnostic } from 'vscode';
import type { Violation } from '../catenary/model/validation';
import type { ModelGraph } from '../catenary/rdf/graph';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { rdf } from '../catenary/rdf/terms';
import { isInstance } from '../catenary/rdf/vocabulary';
import { NS } from '../catenary/model/terms';
import { diagnosticSites, violationOf } from '../read/diagnostics';
import type { GraphResult } from './turtle-api';

export { SHACL_CODE } from '../read/diagnostics';

export function diagnosticsOf(graph: ModelGraph, result: GraphResult, byUri: Record<string, Diagnostic[]>, textOf: (uri: string) => string): Violation[] {
    const index = shapesIndexOf(graph);
    return diagnosticSites(result, byUri, textOf).map(site => {
        const t = rdf.namedNode(site.focus);
        const classes = site.predicate ? graph.match(t, rdf.namedNode(NS.rdf + 'type'), null).map(q => q.object.value) : [];
        return violationOf(index, site, classes, isInstance(graph, t));
    });
}
