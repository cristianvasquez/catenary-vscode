// The recorded expectations of the old pipeline (K11 deleted it): JSON under test/fixtures/expected/, one file per test file, one line per
// value. The old results were recorded once before the deletion; the tests compare the new results with them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve('test/fixtures/expected');

/**
 * A value as JSON data: an RDF/JS term is `{ termType, value }` (a literal with its language and datatype, a triple term with its parts),
 * a Map is `{ Map: [[key, value], …] }` and a Set is `{ Set: […] }`, both sorted by their JSON text (toEqual ignores their order).
 */
export function json(x: unknown): unknown {
    const sorted = (xs: unknown[]) => xs.map(v => [JSON.stringify(v), v] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, v]) => v);
    const value = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(value);
        if (v instanceof Map) return { Map: sorted([...v].map(([k, e]) => [value(k), value(e)])) };
        if (v instanceof Set) return { Set: sorted([...v].map(value)) };
        if (v && typeof v === 'object' && 'termType' in v && typeof (v as { termType: unknown }).termType === 'string' && 'value' in v) {
            const t = v as { termType: string; value: string; language?: string; datatype?: { value: string }; subject?: unknown; predicate?: unknown; object?: unknown };
            if (t.termType === 'Literal') return { termType: 'Literal', value: t.value, language: t.language ?? '', datatype: t.datatype?.value };
            if (t.termType === 'Quad') return { termType: 'Quad', subject: value(t.subject), predicate: value(t.predicate), object: value(t.object) };
            return { termType: t.termType, value: t.value };
        }
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, e]) => e !== undefined && typeof e !== 'function').map(([k, e]) => [k, value(e)]));
        return v;
    };
    return JSON.parse(JSON.stringify(value(x)) ?? 'null');
}

/** A change of sorted statement keys: the sha256 of the start, the keys added and the keys removed. */
export function changeOf(start: string[], end: string[]): { start: string; added: string[]; removed: string[] } {
    const a = new Set(start), b = new Set(end);
    return { start: createHash('sha256').update(start.join('\n')).digest('hex'), added: end.filter(k => !a.has(k)), removed: start.filter(k => !b.has(k)) };
}

/**
 * The recorded values of one test file (`test/fixtures/expected/<file>.json`), by name. `$ROOT` in a recorded value is the path of the
 * repository root.
 */
export function recorded(file: string): (name: string) => unknown {
    const path = join(DIR, `${file}.json`);
    const data: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'));
    return name => {
        if (!(name in data)) throw new Error(`no recorded value ${name} in ${path}`);
        return JSON.parse(JSON.stringify(data[name]).replaceAll('$ROOT', resolve('.')));
    };
}
