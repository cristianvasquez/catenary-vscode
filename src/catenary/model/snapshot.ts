// Validation mode names used by workspace metadata; adapted from Catenary packages/model/src/snapshot.ts.

/** Validation scope: disabled, elements on open views, or the whole model. This extension uses turtle-lsp diagnostics. */
export type ValidationMode = 'off' | 'views' | 'all';

export const VALIDATION_MODES: readonly ValidationMode[] = ['off', 'views', 'all'];

