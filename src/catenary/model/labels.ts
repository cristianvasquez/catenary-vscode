// Choose labels by predicate and language preference; adapted from Catenary packages/model/src/labels.ts.
import { NS } from './terms';


/** The label predicates in the order of the label rule. */
export const LABEL_PREDICATES = [NS.rdfs + 'label', NS.skos + 'prefLabel', NS.sh + 'name'] as const;


/** A label literal: its text and its language tag (none: undefined or ''). */
export type LabelLiteral = { value: string; language?: string };


/** Case-insensitive label order, then lower case first. */
const compareLabels = (a: string, b: string) => {
    const x = a.toLowerCase().replace(/[—→]/g, '\t'), y = b.toLowerCase().replace(/[—→]/g, '\t');
    return x < y ? -1 : x > y ? 1 : a < b ? 1 : a > b ? -1 : 0;
};


/**
 * The one label rule. `literals`: one list per label predicate, in the order of preference (LABEL_PREDICATES; a node shape and a value set put the predicate that their rename writes first); the candidates are the literals of the first list that has any. Of them: a literal in `language` (equal tag, or a subtag:
 * "en" takes "en-GB"; case-insensitive), else a literal without a language, else the smallest by compareLabels. Several in one step:
 * the smallest. Undefined: no literal (the caller uses the name from the IRI).
 */
export function pickLabel(literals: LabelLiteral[][], language?: string): string | undefined {
    return pickLabelLiteral(literals, language)?.value;
}


/** pickLabel, with the language tag of the picked literal: an edit replaces that literal and keeps other languages. */
export function pickLabelLiteral(literals: LabelLiteral[][], language?: string): LabelLiteral | undefined {
    const candidates = literals.find(l => l.length);
    if (!candidates) return undefined;
    const sorted = [...candidates].sort((a, b) => compareLabels(a.value, b.value));
    const want = language?.trim().toLowerCase();
    const tag = (l: LabelLiteral) => (l.language ?? '').toLowerCase();
    return (want ? sorted.find(l => tag(l) === want || tag(l).startsWith(want + '-')) : undefined) ?? sorted.find(l => !tag(l)) ?? sorted[0];
}

