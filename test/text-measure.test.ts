import { afterEach, expect, test, vi } from 'vitest';
import type { GModelRoot } from '@eclipse-glsp/client';

// Keep GLSP's DOM-independent preparation boundary; exercise the real text measurement below.
vi.mock('@eclipse-glsp/client', () => ({
    GLSPSvgExporter: class { protected prepareSvgElement(svg: SVGSVGElement) { return svg; } }
}));
vi.mock('inversify', () => ({ injectable: () => (target: unknown) => target }));
import { MeasuringSvgExporter } from '../src/webview/text-measure';

class Exporter extends MeasuringSvgExporter {
    prepare(svg: SVGSVGElement) { return this.prepareSvgElement(svg, {} as GModelRoot); }
}

afterEach(() => vi.unstubAllGlobals());

/** Minimal laid-out DOM: one diagnostic row with one measured character. */
function canvas(state: 'invalid' | 'warning', fail = false) {
    const classes = new Set([state]);
    const rect = { left: 0, top: 0, right: 10, bottom: 20, width: 10, height: 20 };
    const row = {
        classList: { contains: (c: string) => classes.has(c as typeof state), remove: (c: string) => classes.delete(c as typeof state), add: (c: string) => classes.add(c as typeof state) },
        closest: () => null,
        getBoundingClientRect: () => rect,
        parentElement: null as unknown
    };
    const text = { data: 'X', parentElement: row };
    const fo = { parentElement: null, getScreenCTM: () => ({ inverse: () => ({}) }), getBoundingClientRect: () => rect };
    row.parentElement = fo;
    const svg = {
        querySelectorAll: (selector: string) => selector === 'foreignObject' ? [fo] : classes.size ? [row] : [],
        ownerDocument: {
            createElement: () => ({ getContext: () => null }),
            createTreeWalker: () => { let read = false; return { nextNode: () => read ? null : (read = true, text) }; },
            createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => rect })
        }
    } as unknown as SVGSVGElement;
    vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
    vi.stubGlobal('DOMPoint', class {
        constructor(public x: number, public y: number) {}
        matrixTransform() { return this; }
    });
    vi.stubGlobal('getComputedStyle', () => {
        if (fail) throw new Error('measurement failed');
        return {
            color: classes.has('invalid') ? 'red' : classes.has('warning') ? 'orange' : 'gray',
            fontStyle: 'normal', fontWeight: '400', fontSize: '20px', fontFamily: 'sans-serif',
            textTransform: 'none', visibility: 'visible', overflowX: 'visible', overflowY: 'visible'
        };
    });
    return { svg, classes };
}

test.each(['invalid', 'warning'] as const)('%s rows supply neutral text fill to Markdown SVG export and restore the canvas state', state => {
    const { svg, classes } = canvas(state);
    const exporter = new Exporter();
    expect(exporter.prepare(svg)).toBe(svg);
    // forDocument writes this measured fill directly into exported SVG text.
    expect(exporter.lines.get('#0')).toMatchObject([{ text: 'X', fill: 'gray' }]);
    expect(classes).toEqual(new Set([state]));
});

test('failed text measurement restores validation classes', () => {
    const { svg, classes } = canvas('warning', true);
    expect(() => new Exporter().prepare(svg)).toThrow('measurement failed');
    expect(classes).toEqual(new Set(['warning']));
});
