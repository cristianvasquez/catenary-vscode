// Kata af1j: the built-in notation files read with n3 give the same notation records as the Oxigraph parser.
import type { Quad, Term } from '@rdfjs/types';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { notations } from '../src/catenary/model/notation';
import type { NQuad, NTerm } from '../src/catenary/model/notation-graph';
import { termToJSON, type TermJSON } from '../src/catenary/model/terms';
import { parseNotationFiles } from '../src/catenary/rdf/notations';
import { parseRdfSync } from '../src/catenary/rdf-files/oxigraph-store';

const DIR = 'src/catenary/rdf/notations';

/** The Oxigraph parse of the notation files, as the old readNotations did it. */
const oxigraphQuads = (): Quad[] => readdirSync(DIR).filter(f => f.endsWith('.ttl')).sort()
    .flatMap(f => parseRdfSync(readFileSync(join(DIR, f), 'utf8'), 'text/turtle'));

/**
 * Engine triples with each blank node named by its place: the name of its holder, the predicate and its own statements, so that the
 * names do not depend on parse order or parser labels (skolemize gives random IRIs). The notation files hold blank nodes as trees.
 */
function canonical(quads: Quad[]): NQuad[] {
    const out = new Map<string, Quad[]>(), holder = new Map<string, Quad>();
    for (const q of quads) {
        (out.get(q.subject.value) ?? out.set(q.subject.value, []).get(q.subject.value)!).push(q);
        if (q.object.termType === 'BlankNode') {
            expect(holder.has(q.object.value), `blank node ${q.object.value} has one holder`).toBe(false);
            holder.set(q.object.value, q);
        }
    }
    const text = (t: Term): string => t.termType === 'BlankNode' ? content(t.value) : JSON.stringify(termToJSON(t));
    const content = (b: string): string => `[${(out.get(b) ?? []).map(q => `${q.predicate.value} ${text(q.object)}`).sort().join('; ')}]`;
    const names = new Map<string, string>();
    const place = (b: string): string => {
        const h = holder.get(b);
        return h ? `${h.subject.termType === 'BlankNode' ? place(h.subject.value) : h.subject.value} ${h.predicate.value} ${content(b)}` : content(b);
    };
    const term = (t: Term): NTerm => t.termType === 'BlankNode'
        ? { termType: 'NamedNode', value: names.get(t.value) ?? names.set(t.value, `urn:skolem:${createHash('sha256').update(place(t.value)).digest('hex')}`).get(t.value)! }
        : termToJSON(t)!;
    const key = (q: NQuad) => JSON.stringify(q);
    const triples = quads.map(q => ({ subject: term(q.subject) as TermJSON, predicate: q.predicate.value, object: term(q.object) })).sort((a, b) => key(a) < key(b) ? -1 : 1);
    expect(new Set(names.values()).size, 'one name per blank node').toBe(names.size);
    return triples;
}

test('the notation files give the same statements and the same notation index as the Oxigraph parser', () => {
    const old = canonical(oxigraphQuads()), now = canonical(parseNotationFiles());
    expect(now.length).toBeGreaterThan(300);
    expect(now).toEqual(old);
    expect(notations(now)).toEqual(notations(old));
});
