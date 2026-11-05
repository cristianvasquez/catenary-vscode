// Kata af1j: the built-in notation files read with n3 give the statements that the Oxigraph parser gave (recorded before K11 removed
// Oxigraph: test/fixtures/expected/notations.json).
import type { Quad, Term } from '@rdfjs/types';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { TripleIndex, iri, triple, type NQuad, type NTerm } from '../src/catenary/model/notation-graph';
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

test('whole-model derivation does not turn a reified triple term into an IRI card', () => {
    const subject = iri('urn:test:subject');
    const data = new TripleIndex([{
        subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies',
        object: triple(iri('urn:test:alice'), 'urn:test:knows', iri('urn:test:bob'))
    }]);
    const got = deriveFigures(data, notations(canonical(parseNotationFiles())), 'urn:test:view');
    expect(got.figures.map(f => f.focus)).toEqual([subject]);
});

test.each(['urn:name:model', 'urn:skolem:blank:abc'])('the catch-all Card excludes %s', value => {
    const got = deriveFigures(new TripleIndex(), notations(canonical(parseNotationFiles())), 'urn:test:view', [iri(value)]);
    expect(got.figures).toEqual([]);
});

test.each([20, 23])('unshaped rows sort by predicate and value, with a cap for %s statements', count => {
    const focus = iri('urn:test:subject');
    const data = new TripleIndex(Array.from({ length: count }, (_, i) => ({
        subject: focus, predicate: `urn:test:${i % 2 ? 'z' : 'a'}`,
        object: { termType: 'Literal' as const, value: String(count - i).padStart(2, '0') }
    })));
    const got = deriveFigures(data, notations(canonical(parseNotationFiles())), 'urn:test:view', [focus]);
    const rows = got.figures.find(f => f.focus.value === focus.value)!.rows;
    const sorted = Array.from({ length: count }, (_, i) => `${i % 2 ? 'z' : 'a'}: ${String(count - i).padStart(2, '0')}`).sort();
    expect(rows.map(r => r.text)).toEqual([...sorted.slice(0, 20), ...(count > 20 ? [`… +${count - 20} more`] : [])]);
    expect(rows.every(r => r.shaped === false)).toBe(true);
});

test('shaped rows stay first and unchanged; title and type statements are not unshaped rows', () => {
    const focus = iri('urn:test:subject'), shape = iri('urn:test:shape'), ps = iri('urn:test:property');
    const sh = 'http://www.w3.org/ns/shacl#';
    const data = new TripleIndex([
        { subject: focus, predicate: TYPE, object: iri('urn:test:Class') },
        { subject: shape, predicate: sh + 'targetClass', object: iri('urn:test:Class') },
        { subject: shape, predicate: sh + 'property', object: ps },
        { subject: ps, predicate: sh + 'path', object: iri('urn:test:z') },
        { subject: ps, predicate: sh + 'name', object: { termType: 'Literal', value: 'shaped name' } },
        ...['z', 'a', 'http://www.w3.org/2000/01/rdf-schema#label', 'http://www.w3.org/2004/02/skos/core#prefLabel', sh + 'name'].map(p => ({
            subject: focus, predicate: p.includes(':') ? p : `urn:test:${p}`, object: { termType: 'Literal' as const, value: 'value' }
        }))
    ]);
    const notes = notations(canonical(parseNotationFiles()));
    const card = () => deriveFigures(data, notes, 'urn:test:view', [focus]).figures.find(f => f.focus.value === focus.value)!;
    // The notation's rdf:type text role supplies the class line before gathered rows.
    expect(card().rows.map(r => r.text)).toEqual(['rdf:type: Class', 'shaped name: value', 'a: value']);
    expect(card().rows[1].gathered).toEqual(ps);
    expect(card().rows[1].shaped).toBeUndefined();
    expect(card().rows[2].shaped).toBe(false);
});

test('the notation files give the recorded statements of the Oxigraph parser', () => {
    const now = canonical(parseNotationFiles());
    expect(now.length).toBeGreaterThan(300);
    expect(json(now)).toEqual(R('statements'));
});
