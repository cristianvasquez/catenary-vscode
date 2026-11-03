// Convert canvas SVG into document SVG without editor controls; adapted from Catenary modeler/src/browser/diagram/markdown-export.ts.
import { EDIT_CONTROLS, TextLine, VALIDATION_BADGES, foreignObjectKey } from "./text-measure";

/** Properties of the canvas element (its size in the window, its box), not of the diagram. */
const CANVAS_PROPERTY = /^(width|height|(min-|max-)?(block|inline)-size|(min|max)-(width|height)|flex|perspective-origin|transform-origin|cursor|border|user-select|position|inset|top|left|right|bottom)/;

/** The view box from getBBox does not contain the stroke width: a margin keeps the frame borders and titles. */
const MARGIN = 8;

/**
 * The export copies computed styles: the root also gets the size of the canvas (block-size, width, height) and every CSS
 * custom property of the window (about 100 KB). Computed values do not use custom properties, so they are removed on all
 * elements. The size goes to the width and height attributes, so that the page CSS can scale the figure down. Edit controls
 * and violation badges are removed (the validation classes are removed before the style copy, MeasuringSvgExporter.createSvg). Each foreignObject (card and note contents, HTML) becomes SVG text at the positions measured in the export canvas (text-measure.ts), so
 * that viewers without HTML in SVG (librsvg, imv) draw the same lines.
 */
export function forDocument(svg: string, lines: Map<string, TextLine[]> = new Map(), fonts: (list: string) => string = list => list): string {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const bounds = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (!(root instanceof SVGSVGElement) || bounds?.length !== 4) return svg;
    const [x, y, w, h] = bounds;
    const box = [x - MARGIN, y - MARGIN, w + 2 * MARGIN, h + 2 * MARGIN];
    root.setAttribute('viewBox', box.join(' '));
    root.querySelectorAll(`${EDIT_CONTROLS}, ${VALIDATION_BADGES}`).forEach(e => e.remove());
    addBackground(root, box);
    for (const fo of [...root.querySelectorAll('foreignObject')]) {
        const g = doc.createElementNS(SVG_NS, 'g');
        for (const line of lines.get(foreignObjectKey(fo)) ?? []) g.appendChild(textElement(doc, line));
        fo.replaceWith(g);
    }
    for (const e of [root, ...root.querySelectorAll<SVGElement | HTMLElement>('[style]')]) {
        normalizeStyle(e);
        const style = e.style;
        for (const p of [...style]) if (p.startsWith('--') || (e === root && CANVAS_PROPERTY.test(p))) style.removeProperty(p);
        if (!style.length) e.removeAttribute('style');
    }
    // Each font list names the font that the canvas draws first (text-measure.ts withDrawnFont).
    for (const e of [root, ...root.querySelectorAll<SVGElement>('*')]) {
        const family = e.style?.fontFamily;
        if (family) e.style.fontFamily = fonts(family);
        const attr = e.getAttribute('font-family');
        if (attr) e.setAttribute('font-family', fonts(attr));
    }
    root.querySelectorAll<SVGElement>('*').forEach(e => {
        for (const attr of ['fill', 'stroke', 'color']) {
            const value = e.getAttribute(attr);
            if (value) e.setAttribute(attr, normalizeColor(value));
        }
    });
    root.setAttribute('width', String(Math.ceil(box[2])));
    root.setAttribute('height', String(Math.ceil(box[3])));
    return new XMLSerializer().serializeToString(root);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A text line as SVG. textLength keeps the measured width when a viewer uses another font. */
function textElement(doc: Document, line: TextLine): SVGTextElement {
    const t = doc.createElementNS(SVG_NS, 'text') as SVGTextElement;
    const round = (n: number) => String(Math.round(n * 100) / 100);
    t.setAttribute('x', round(line.x));
    t.setAttribute('y', round(line.y));
    t.setAttribute('fill', normalizeColor(line.fill));
    t.setAttribute('font-family', line.fontFamily);
    t.setAttribute('font-size', round(line.fontSize));
    if (line.fontWeight !== '400') t.setAttribute('font-weight', line.fontWeight);
    if (line.fontStyle !== 'normal') t.setAttribute('font-style', line.fontStyle);
    if (line.width > 0) {
        t.setAttribute('textLength', round(line.width));
        t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    t.setAttribute('xml:space', 'preserve');
    t.textContent = line.text;
    return t;
}

function addBackground(root: SVGSVGElement, box: number[]): void {
    const background = root.style.backgroundColor;
    if (!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)') return;
    const rect = root.ownerDocument.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(box[0]));
    rect.setAttribute('y', String(box[1]));
    rect.setAttribute('width', String(box[2]));
    rect.setAttribute('height', String(box[3]));
    rect.setAttribute('fill', normalizeColor(background));
    root.insertBefore(rect, root.firstChild);
}

function normalizeStyle(e: SVGElement | HTMLElement): void {
    const style = e.getAttribute('style');
    if (style) e.setAttribute('style', normalizeColor(style));
}

function normalizeColor(value: string): string {
    return value.replace(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/g,
        (_m, r, g, b, a) => a === undefined
            ? `rgb(${toByte(r)}, ${toByte(g)}, ${toByte(b)})`
            : `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${roundAlpha(a)})`);
}

function toByte(n: string): number {
    return Math.max(0, Math.min(255, Math.round(Number(n) * 255)));
}

function roundAlpha(n: string): string {
    return String(Math.max(0, Math.min(1, Number(n))).toFixed(3)).replace(/0+$/, '').replace(/[.]$/, '');
}
