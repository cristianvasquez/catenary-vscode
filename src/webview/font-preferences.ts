// Apply shared font-size preferences as CSS variables; adapted from Catenary modeler/src/browser/diagram/font-preferences.ts.
// canvas.css scales card, group and note text; preferences are not stored in view or model files.

import { Emitter } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { CanvasPreferences } from './preferences';

const CARD_FONT_SIZE = 'catenary.cardFontSize';
const GROUP_FONT_SIZE = 'catenary.groupFontSize';
const NOTE_FONT_SIZE = 'catenary.noteFontSize';
/** Default font sizes in canvas units. */
const FONT_DEFAULTS: Record<string, number> = { [CARD_FONT_SIZE]: 40, [GROUP_FONT_SIZE]: 47, [NOTE_FONT_SIZE]: 40 };
/** The card text size that the card geometry (heights, widths) is drawn for. The card scale is the size over this base. */
const CARD_FONT_BASE = 22;
const FONT_MIN = 8;
const FONT_MAX = 72;

@injectable()
export class FontPreferences {
    @inject(CanvasPreferences) protected readonly preferences!: CanvasPreferences;
    protected readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;

    onStart(): void {
        this.apply();
        this.preferences.onDidChange(names => { if (names.some(n => n in FONT_DEFAULTS)) { this.apply(); this.changed.fire(); } });
    }

    get(name: string): number {
        const n = Number(this.preferences.get(name, FONT_DEFAULTS[name]));
        return Number.isFinite(n) ? Math.min(FONT_MAX, Math.max(FONT_MIN, n)) : FONT_DEFAULTS[name];
    }

    /** Card text scale: the "Card text" size / CARD_FONT_BASE. The GLSP server gets it (`catenarySetCardScale`) for the card heights. */
    get cardScale(): number {
        return this.get(CARD_FONT_SIZE) / CARD_FONT_BASE;
    }

    protected apply(size: (name: string) => number = n => this.get(n)): void {
        const root = document.documentElement.style;
        root.setProperty('--catenary-card-scale', String(size(CARD_FONT_SIZE) / CARD_FONT_BASE));
        root.setProperty('--catenary-group-font-size', `${size(GROUP_FONT_SIZE)}px`);
        root.setProperty('--catenary-note-font-size', `${size(NOTE_FONT_SIZE)}px`);
    }
}
