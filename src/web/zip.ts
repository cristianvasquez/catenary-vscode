// A ZIP archive of text files without compression (method 0, "stored"), for the download of the workspace.

const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: { name: string; text: string }[]): Blob {
    const encoder = new TextEncoder(), parts: Uint8Array[] = [], central: Uint8Array[] = [];
    let offset = 0;
    for (const { name, text } of entries) {
        const nameBytes = encoder.encode(name), data = encoder.encode(text), crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
        local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true);
        const dir = new DataView(new ArrayBuffer(46));
        dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
        dir.setUint32(16, crc, true); dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, nameBytes.length, true);
        dir.setUint32(42, offset, true);
        parts.push(new Uint8Array(local.buffer), nameBytes, data);
        central.push(new Uint8Array(dir.buffer), nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const size = central.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' });
}
