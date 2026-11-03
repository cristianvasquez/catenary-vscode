// Browser stand-in for node:crypto in the web build: the functions that the shared code uses. createHash('sha256') must be synchronous
// (placement IRIs, catenary/rdf/views.ts) and equal to Node's digest, so that a view file names the same placements in VS Code and here.

export const randomUUID = (): string => globalThis.crypto.randomUUID();

export function randomBytes(n: number): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function sha256(data: Uint8Array): Uint8Array {
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const length = Math.ceil((data.length + 9) / 64) * 64, block = new Uint8Array(length);
    block.set(data);
    block[data.length] = 0x80;
    const view = new DataView(block.buffer), bits = data.length * 8;
    view.setUint32(length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(length - 4, bits >>> 0);
    const w = new Uint32Array(64), rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    for (let at = 0; at < length; at += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        let [a, b, c, d, e, f, g, k] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
    }
    const out = new Uint8Array(32), outView = new DataView(out.buffer);
    h.forEach((x, i) => outView.setUint32(i * 4, x));
    return out;
}

/** createHash('sha256'): update with strings (UTF-8) or bytes, digest as 'hex' or bytes. */
export function createHash(algorithm: string) {
    if (algorithm !== 'sha256') throw new Error(`createHash: only sha256 is available in the browser, not ${algorithm}`);
    const chunks: Uint8Array[] = [];
    const hash = {
        update(data: string | Uint8Array) {
            chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
            return hash;
        },
        digest(encoding?: 'hex') {
            const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const c of chunks) { all.set(c, at); at += c.length; }
            const bytes = sha256(all);
            return encoding === 'hex' ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join('') : bytes;
        }
    };
    return hash;
}

export default { randomUUID, randomBytes, createHash };
