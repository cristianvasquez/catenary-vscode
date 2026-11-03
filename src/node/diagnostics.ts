// Map turtle-lsp diagnostic ranges to diagram elements and violation records; VS Code severities are zero-based (LSP: one-based).
// Positions and text both come from the saved file.
import type { Diagnostic } from 'vscode';
import type { Violation } from '../catenary/model/validation';
import type { ModelGraph } from '../catenary/rdf/graph';
import { elementId } from '../catenary/rdf/ids';
import { shapesIndexOf } from '../catenary/rdf/shapes-read';
import { rdf, termKey } from '../catenary/rdf/terms';
import { isInstance } from '../catenary/rdf/vocabulary';
import { NS } from '../catenary/model/terms';
import { toEngine } from '../model/graph-input';
import type { GraphResult } from './turtle-api';

// Observed in test VS Code with turtle-lsp 0.13.0: publicationYear maxCount diagnostic, source "turtle".
export const SHACL_CODE = 'shacl-violation';
type Position = { line: number; character: number };
/** The text between two positions; a position outside the text counts as non-whitespace, so that stale positions take no literal. */
const between = (text: string, a: Position, b: Position) => {
    const lines = text.split('\n');
    if (a.line >= lines.length || b.line >= lines.length || a.character > lines[a.line].length || b.character > lines[b.line].length) return '?';
    return a.line === b.line ? lines[a.line].slice(a.character, b.character)
        : [lines[a.line].slice(a.character), ...lines.slice(a.line + 1, b.line), lines[b.line].slice(0, b.character)].join('\n');
};
export function diagnosticsOf(graph: ModelGraph, result: GraphResult, byUri: Record<string, Diagnostic[]>, textOf: (uri: string) => string): Violation[] {
    const within = (r: GraphResult['nodes'][number]['range'], p: { line: number; character: number }) =>
        (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character)) && (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));
    const before = (a: { line: number; character: number }, b: { line: number; character: number }) => a.line < b.line || (a.line === b.line && a.character <= b.character);
    const nodeAt = (uri: string, range: Diagnostic['range'], literal: boolean) => result.nodes.findIndex(n => n.uri === uri && n.literal === literal && within(n.range, range.start));
    const out: Violation[] = [], index = shapesIndexOf(graph);
    for (const [uri, list] of Object.entries(byUri)) for (const d of list) {
        if (d.code !== SHACL_CODE) continue;
        let focus: string | undefined, predicate: string | undefined;
        let value = nodeAt(uri, d.range, true);
        // Predicate-only diagnostics: the object is the next literal when only whitespace separates them.
        if (value < 0) {
            const next = result.nodes.reduce((best, n, i) => n.uri === uri && n.literal && before(d.range.end, n.range.start)
                && (best < 0 || before(n.range.start, result.nodes[best].range.start)) ? i : best, -1);
            if (next >= 0 && !between(textOf(uri), d.range.end, result.nodes[next].range.start).trim()) value = next;
        }
        const edge = value >= 0 ? result.edges.find(e => e.target === value) : undefined;
        if (edge) { focus = result.nodes[edge.source].id; predicate = edge.predicate; }
        const node = focus === undefined ? nodeAt(uri, d.range, false) : -1;
        if (node >= 0) focus = result.nodes[node].id;
        if (focus === undefined) {
            const subjects = new Set(result.edges.filter(e => e.uri === uri).map(e => e.source));
            const last = [...subjects].map(i => result.nodes[i]).filter(n => before(n.range.start, d.range.start)).sort((a, b) => before(a.range.start, b.range.start) ? 1 : -1)[0];
            focus = last?.id;
        }
        if (focus === undefined) continue;
        const iri = toEngine(focus), t = rdf.namedNode(iri);
        const related = d.relatedInformation?.[0]?.location;
        const shapeNode = related ? nodeAt(related.uri.toString(), related.range, false) : -1;
        const shapeId = shapeNode >= 0 ? result.nodes[shapeNode].id : undefined;
        let shape = shapeId ? index.byTerm.get(termKey(rdf.namedNode(toEngine(shapeId)))) : undefined;
        // turtle-lsp can omit relatedInformation. Only infer an unambiguous simple property shape.
        if (!shape && predicate) {
            const classes = graph.match(t, rdf.namedNode(NS.rdf + 'type'), null).map(q => q.object.value);
            const candidates = Object.values(index.model.properties).filter(p => p.path.kind === 'iri' && p.path.iri === predicate
                && index.model.nodeShapes[p.owner]?.targetClasses?.some(c => classes.includes(c)));
            if (candidates.length === 1) shape = candidates[0].id;
        }
        out.push({
            focus: iri, ...(isInstance(graph, t) ? { instance: elementId(t) } : {}), ...(predicate ? { path: predicate } : {}),
            ...(shape && index.property.has(shape) ? { shape } : {}), severity: d.severity === 1 ? 'Warning' : d.severity === 2 || d.severity === 3 ? 'Info' : 'Violation',
            component: '', message: d.message, uri, range: d.range
        });
    }
    return out;
}
