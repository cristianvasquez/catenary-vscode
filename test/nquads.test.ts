import { expect, test } from 'vitest';
import { OxigraphStore } from '../src/catenary/rdf-files/oxigraph-store';
import { rdf, termKey } from '../src/catenary/rdf/terms';
import { nquadsOf } from '../src/model/nquads';

const G = 'file:///w/data.ttl', XSD = 'http://www.w3.org/2001/XMLSchema#';
const s = { termType: 'NamedNode', value: 'urn:x:s' } as const;
const quads = [
    { subject: s, predicate: 'urn:x:p', object: { termType: 'NamedNode', value: 'urn:x:o' }, graph: G },
    { subject: s, predicate: 'urn:x:p', object: { termType: 'Literal', value: 'say "hi"\nthen go \\ back' }, graph: G },
    { subject: s, predicate: 'urn:x:p', object: { termType: 'Literal', value: 'bonjour', language: 'fr' }, graph: G },
    { subject: s, predicate: 'urn:x:p', object: { termType: 'Literal', value: '42', datatype: XSD + 'integer' }, graph: G },
    { subject: { termType: 'BlankNode', value: '_:3:7' }, predicate: 'urn:x:p', object: s, graph: G },
    { subject: s, predicate: 'urn:x:p', object: { termType: 'Triple', value: '', subject: s, predicate: { termType: 'NamedNode', value: 'urn:x:q' }, object: { termType: 'Literal', value: 'v' } }, graph: G }
] as const;

test('nquadsOf writes one escaped line per quad', () => {
    expect(nquadsOf(quads).split('\n')).toEqual([
        '<urn:x:s> <urn:x:p> <urn:x:o> <file:///w/data.ttl> .',
        '<urn:x:s> <urn:x:p> "say \\"hi\\"\\nthen go \\\\ back" <file:///w/data.ttl> .',
        '<urn:x:s> <urn:x:p> "bonjour"@fr <file:///w/data.ttl> .',
        `<urn:x:s> <urn:x:p> "42"^^<${XSD}integer> <file:///w/data.ttl> .`,
        '<urn:skolem:blank:000003-00000007> <urn:x:p> <urn:x:s> <file:///w/data.ttl> .',
        '<urn:x:s> <urn:x:p> <<( <urn:x:s> <urn:x:q> "v" )>> <file:///w/data.ttl> .',
        ''
    ]);
});

test('OxigraphStore.load of the text gives the same quads back', () => {
    const store = new OxigraphStore();
    store.load(nquadsOf(quads), 'application/n-quads');
    const g = rdf.namedNode(G), x = rdf.namedNode('urn:x:s'), p = rdf.namedNode('urn:x:p');
    const expected = [
        rdf.quad(x, p, rdf.namedNode('urn:x:o'), g),
        rdf.quad(x, p, rdf.literal('say "hi"\nthen go \\ back'), g),
        rdf.quad(x, p, rdf.literal('bonjour', 'fr'), g),
        rdf.quad(x, p, rdf.literal('42', rdf.namedNode(XSD + 'integer')), g),
        rdf.quad(rdf.namedNode('urn:skolem:blank:000003-00000007'), p, x, g),
        rdf.quad(x, p, rdf.quad(x, rdf.namedNode('urn:x:q'), rdf.literal('v')), g)
    ];
    const key = (q: { subject: unknown; predicate: unknown; object: unknown; graph: unknown }) =>
        [q.subject, q.predicate, q.object, q.graph].map(t => termKey(t as Parameters<typeof termKey>[0])).join(' ');
    expect(store.match().map(key).sort()).toEqual(expected.map(key).sort());
});
