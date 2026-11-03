import { expect, test } from 'vitest';
import { newViewText, viewFileName } from '../src/node/new-view';
import { viewIriOf } from '../src/model/graph-input';

test('a new view file reads as a view with its canonical-md IRI', () => {
    expect(viewIriOf(newViewText('My view'))).toBe('urn:name:My%20view');
    expect(viewIriOf(newViewText('a "quoted"\\ name'))).toBe('urn:name:a%20%22quoted%22%5C%20name');
});

test('the file name replaces the characters that file systems refuse', () => {
    expect(viewFileName('Bookshop')).toBe('Bookshop.trig');
    expect(viewFileName('a/b:c')).toBe('a-b-c.trig');
});
