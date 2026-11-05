// Kata af1j: the built-in notation files read with n3 give the statements that the Oxigraph parser gave (recorded before K11 removed
// Oxigraph: test/fixtures/expected/notations.json).
import type { Quad, Term } from '@rdfjs/types';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { TripleIndex, iri, type NQuad, type NTerm } from '../src/catenary/model/notation-graph';
import { deriveFigures, notations } from '../src/catenary/model/notation';
import { termToJSON, type TermJSON } from '../src/catenary/model/terms';
import { parseNotationFiles } from '../src/catenary/rdf/notations';
import { json, recorded } from './expected';

const R = recorded('notations');
const VIEW_NS = 'https://cristianvasquez.github.io/catenary/vocab/view#';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

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

test.each(['View', 'Placement', 'Note', 'Frame', 'EntityGroup', 'Pill', 'FileRef', 'FutureMark'])('the catch-all Card excludes view:%s', name => {
    const focus = iri('urn:test:subject');
    const data = new TripleIndex([{ subject: focus, predicate: TYPE, object: iri(VIEW_NS + name) }]);
    const got = deriveFigures(data, notations(canonical(parseNotationFiles())), 'urn:test:view', [focus]);
    expect(got.figures.some(f => f.fs.node.value.endsWith('/instances#Card'))).toBe(false);
});

test.each(['urn:name:model', 'urn:skolem:blank:abc'])('the catch-all Card excludes %s', value => {
    const got = deriveFigures(new TripleIndex(), notations(canonical(parseNotationFiles())), 'urn:test:view', [iri(value)]);
    expect(got.figures).toEqual([]);
});

test('the notation files give the recorded statements of the Oxigraph parser', () => {
    const now = canonical(parseNotationFiles());
    expect(now.length).toBeGreaterThan(300);
    expect(json(now)).toEqual(R('statements'));
});
