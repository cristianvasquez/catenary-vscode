// Apply vocabulary color preferences to path label parts; adapted from Catenary modeler/src/browser/diagram/vocabulary-color.ts.
// Color the prefix or local name by namespace; urn:name: prefixes remain hidden.

export const VOCABULARY_COLORS = ['name', 'prefix', 'off'] as const;
export type VocabularyColor = typeof VOCABULARY_COLORS[number];
export const VOCABULARY_COLOR_DEFAULT: VocabularyColor = 'name';

let current: VocabularyColor = VOCABULARY_COLOR_DEFAULT;
export const setVocabularyColor = (mode: VocabularyColor): void => { current = mode; };

export interface DrawnPart { text: string; color?: string; muted: boolean }
/** A label part (LabelPart of @catenary/model). */
export interface Part { text: string; color?: string; prefix?: boolean; hidden?: boolean }

/**
 * The drawn parts of a path label. name: the local name in the namespace color, the prefix muted. prefix: the prefix in the namespace color,
 * the local name plain. off: no color, the prefix muted. Operators stay muted. An IRI without a prefix keeps its color, except with off.
 * A hidden prefix (urn:name:) is not drawn: with prefix, its name is plain.
 */
export function vocabularyParts(parts: readonly Part[], mode: VocabularyColor = current): DrawnPart[] {
    const isPrefix = (i: number) => !!parts[i]?.prefix && !!parts[i + 1]?.color;
    return parts.flatMap((x, i): DrawnPart[] => x.hidden ? [] : [drawn(x, i)]);
    function drawn(x: Part, i: number): DrawnPart {
        if (mode === 'prefix' && isPrefix(i)) return { text: x.text, color: parts[i + 1].color, muted: false };
        if ((mode === 'prefix' && isPrefix(i - 1)) || (mode === 'off' && x.color)) return { text: x.text, muted: false };
        return { text: x.text, color: x.color, muted: !x.color };
    }
}
