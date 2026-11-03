import { Parser } from 'n3';
import { expect, test } from 'vitest';
import { NS } from '../src/catenary/model/terms';
import { newViewText, viewFileName } from '../src/node/new-view';

/** The graphs `?g` of the statements `?g a view:View` of a TriG text. */
const viewIris = (text: string) => new Parser({ format: 'application/trig' }).parse(text)
    .filter(q => q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'View' && q.subject.equals(q.graph)).map(q => q.graph.value);

test('a new view file reads as a view with its canonical-md IRI', () => {
    expect(viewIris(newViewText('My view'))).toEqual(['urn:name:My%20view']);
    expect(viewIris(newViewText('a "quoted"\\ name'))).toEqual(['urn:name:a%20%22quoted%22%5C%20name']);
});

test('the file name replaces the characters that file systems refuse', () => {
    expect(viewFileName('Bookshop')).toBe('Bookshop.trig');
    expect(viewFileName('a/b:c')).toBe('a-b-c.trig');
});
