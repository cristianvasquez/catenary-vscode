import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FileStore } from '../src/web/files';
import { files } from '../src/web/shims/fs';

let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
    files.clear();
    setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
});

afterEach(() => {
    files.clear();
    vi.unstubAllGlobals();
});

test('a write persists all files and unchanged stored text needs no write', () => {
    const store = new FileStore({ 'sample.ttl': 'sample' });
    expect(store.write('sample.ttl', 'changed')).toBe(true);
    expect(setItem).toHaveBeenCalledWith('catenary-web-files', JSON.stringify({ 'sample.ttl': 'changed' }));
    expect(store.write('sample.ttl', 'changed')).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(1);
});

test('a failed write stays unstored until another file is persisted', () => {
    const store = new FileStore({ 'sample.ttl': 'sample' });
    setItem.mockImplementation(() => { throw new Error('full'); });
    expect(store.write('sample.ttl', 'changed')).toBe(false);
    expect(store.read('sample.ttl')).toBe('changed');
    expect(store.unstored).toEqual(new Set(['sample.ttl']));
    setItem.mockImplementation(() => undefined);
    expect(store.write('other.ttl', 'other')).toBe(true);
    expect(store.unstored.size).toBe(0);
    expect(setItem).toHaveBeenLastCalledWith('catenary-web-files', JSON.stringify({ 'other.ttl': 'other', 'sample.ttl': 'changed' }));
});

test('failed writes can retry unchanged text and failed deletes are tracked', () => {
    const store = new FileStore({ 'sample.ttl': 'sample' });
    setItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(store.write('sample.ttl', 'changed')).toBe(false);
    setItem.mockImplementation(() => undefined);
    expect(store.write('sample.ttl', 'changed')).toBe(true);
    expect(store.unstored.size).toBe(0);
    setItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(store.delete('sample.ttl')).toBe(false);
    expect(store.has('sample.ttl')).toBe(false);
    expect(store.unstored).toEqual(new Set(['sample.ttl']));
    setItem.mockImplementation(() => undefined);
    expect(store.write('other.ttl', 'other')).toBe(true);
    expect(store.unstored.size).toBe(0);
    expect(setItem).toHaveBeenLastCalledWith('catenary-web-files', JSON.stringify({ 'other.ttl': 'other' }));
});
