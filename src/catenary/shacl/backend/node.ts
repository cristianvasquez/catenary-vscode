// Read node shape references; adapted from Catenary packages/shacl/src/backend/node.ts.
import { RDF, SH } from '../../contracts/query';
import { iri } from '../../contracts/query';
import type { QueryTerm, TargetQueryPort } from './targets';


export interface NodeReference {
    source: string;
    target: string;
    property?: string;
    /** A compiled SPARQL property path. Only the shape reader produces this value. */
    path?: string;
}


/** Read shape structure once per shape revision. Paths can cross source files. */
export function readNodeReferences(port: TargetQueryPort, graphs: readonly string[]): NodeReference[] {
    if (!graphs.length) return [];
    const rows = port.select(`SELECT ?s ?p ?o ${graphs.map(g => `FROM ${iri(g)}`).join(' ')} WHERE { ?s ?p ?o }`);
    const index = new Map<string, QueryTerm[]>(), byProperty = new Map<string, string[]>();
    for (const r of rows) {
        if (r.p.value === SH + 'property') byProperty.set(r.o.value, [...byProperty.get(r.o.value) ?? [], r.s.value]);
        const key = JSON.stringify([r.s.value, r.p.value]);
        const values = index.get(key) ?? [];
        values.push(r.o);
        index.set(key, values);
    }
    const values = (s: string, p: string) => index.get(JSON.stringify([s, p])) ?? [];
    const path = (id: string, seen = new Set<string>()): string => {
        if (seen.has(id)) throw new Error('Cyclic SHACL property path.');
        const next = new Set([...seen, id]);
        const list = (head: string): string[] => {
            const result: string[] = [], cells = new Set<string>();
            for (let cell = head; cell !== RDF + 'nil';) {
                if (cells.has(cell)) throw new Error('Cyclic SHACL path list.');
                cells.add(cell);
                const first = values(cell, RDF + 'first')[0], rest = values(cell, RDF + 'rest')[0];
                if (!first || !rest) throw new Error('Incomplete SHACL path list.');
                result.push(path(first.value, next)); cell = rest.value;
            }
            return result;
        };
        if (values(id, RDF + 'first').length) return `(${list(id).join('/')})`;
        for (const [name, suffix] of [['inversePath', ''], ['zeroOrMorePath', '*'], ['oneOrMorePath', '+'], ['zeroOrOnePath', '?']]) {
            const inner = values(id, SH + name)[0];
            if (inner) return name === 'inversePath' ? `^(${path(inner.value, next)})` : `(${path(inner.value, next)})${suffix}`;
        }
        const alt = values(id, SH + 'alternativePath')[0];
        return alt ? `(${list(alt.value).join('|')})` : iri(id);
    };
    const refs: NodeReference[] = [];
    for (const r of rows.filter(r => r.p.value === SH + 'node' && r.o.termType === 'NamedNode')) {
        const p = values(r.s.value, SH + 'path')[0];
        if (!p) { refs.push({ source: r.s.value, target: r.o.value }); continue; }
        const owners = byProperty.get(r.s.value) ?? [];
        for (const source of new Set([r.s.value, ...owners])) refs.push({ source, target: r.o.value, property: r.s.value, path: path(p.value) });
    }
    return refs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
