import { createHash as nodeHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createHash } from '../src/web/shims/crypto';

test('the browser SHA-256 equals node:crypto for placement keys', () => {
    const inputs = ['', 'a', 'abc', '<urn:name:Bookshop>', 'é ü 中文 🎉', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)];
    for (const s of inputs) expect(createHash('sha256').update(s).digest('hex')).toBe(nodeHash('sha256').update(s).digest('hex'));
});
