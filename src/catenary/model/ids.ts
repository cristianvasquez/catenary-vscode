// Encode reversible element and relation ids; adapted from Catenary packages/model/src/ids.ts.
// Characters outside [A-Za-z0-9] use _xx escapes of UTF-8 bytes.

export function escapeId(s: string): string {
    let out = '';
    for (const ch of s) {
        if (/[A-Za-z0-9]/.test(ch)) { out += ch; continue; }
        let bytes: string[];
        try {
            const enc = encodeURIComponent(ch);
            bytes = enc.startsWith('%') ? enc.slice(1).split('%') : [ch.charCodeAt(0).toString(16)];
        } catch {
            bytes = ['ef', 'bf', 'bd'];   // a lone surrogate: U+FFFD, as TextEncoder writes it
        }
        for (const b of bytes) out += '_' + b.toLowerCase().padStart(2, '0');
    }
    return out;
}


export function unescapeId(s: string): string | undefined {
    if (!/^(?:[A-Za-z0-9]|_[0-9a-f]{2})*$/.test(s)) return undefined;
    try {
        return decodeURIComponent(s.replace(/_([0-9a-f]{2})/g, '%$1'));
    } catch {
        return undefined;
    }
}


/** Id of the element with this IRI (instance, view, view element, node shape, value set, concept). */
export function iriId(iri: string): string {
    return 'n-' + escapeId(iri);
}


/** IRI of an element id of the form "n-…"; undefined for other ids. */
export function idIri(id: string): string | undefined {
    const value = id.startsWith('n-') ? unescapeId(id.slice(2)) : undefined;
    return value || undefined;
}


/** Id of the relation (s, p, o), from the IRIs of its terms. */
export function relationIdOf(s: string, p: string, o: string): string {
    return `r-${escapeId(s)}-${escapeId(p)}-${escapeId(o)}`;
}

