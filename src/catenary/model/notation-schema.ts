// Convert joined notation figures into diagram elements; adapted from Catenary packages/model/src/notation-schema.ts.
import { targetText } from '../shacl/common/index';
import { Doc } from './doc';
import { ElementSchema, GraphOptions, LATENT_SUFFIX, LEAF_SUFFIX, TYPES, edgeLanes, memberListHeight } from './diagram-schema';
import { iriId, escapeId } from './ids';
import { Figure, listHolder } from './notation';
import { nkey } from './notation-graph';
import { ViewFigures, partIsRow } from './notation-join';
import { ONE_OF_WIDTH, SHAPE_CARD, ShapeRow, alternativeRows, leafStyle, pillSize, shapeCardHeight } from './shapes-schema';
import { PropertyShape, cardinalityText, formatPath, pathParts, rangeText, shortIri } from './shapes-doc';
import { CATENARY_VOCAB, NS, localName } from './terms';


const SHN = CATENARY_VOCAB + 'notation/shapes#', VSN = CATENARY_VOCAB + 'notation/skos#';

const shapeOf = (f: Figure) => f.fs.node.value;

const isShapes = (f: Figure) => shapeOf(f).startsWith(SHN);

const isValueSets = (f: Figure) => shapeOf(f) === VSN + 'Scheme' || shapeOf(f) === VSN + 'Collection';


/** The constraint id (`c-<operator>-<shape>-<n>`) of a hub figure: the inputs of its list term. */
function hubConstraintId(vf: ViewFigures, hub: Figure): string | undefined {
    const h = listHolder(vf.derivation.data, hub.focus);
    return h && `c-${h.predicate.slice(NS.sh.length)}-${escapeId(h.subject.value)}-${h.n}`;
}


export interface NotationElements { edges: ElementSchema[]; cards: ElementSchema[]; overlays: ElementSchema[]; ids: Set<string> }


/** The SHACL and value-set elements of `view` (shapes notation `shn:`, value-set notation `vsn:`). */
export function notationElements(doc: Doc, vf: ViewFigures, opts: GraphOptions): NotationElements {
    const { shapes } = doc;
    const D = vf.derivation.data;
    const label = (iri: string) => Object.values(shapes.valueSets).find(v => v.uri === iri)?.label ?? opts.schemeLabel?.(iri) ?? localName(iri);
    const placement = (f: Figure) => vf.placed.get(nkey(f.placedAs));
    const placementId = (f: Figure) => { const p = placement(f); return p ? iriId(p.iri) : iriId(f.focus.value); };
    const problems = new Map<string, number>();
    for (const v of opts.violations) if (v.shape && v.severity === 'Violation') problems.set(v.shape, (problems.get(v.shape) ?? 0) + 1);
    const scale = opts.cardScale ?? 1;

    /** The property shape of a line figure with its start card (a shared property shape has one id per owner). */
    const propertyOf = (line: Figure, start?: Figure): PropertyShape | undefined => {
        const all = Object.values(shapes.properties).filter(p => p.uri === line.focus.value);
        return (start && all.find(p => p.owner === iriId(start.focus.value))) ?? all[0];
    };
    /** The box id of a list figure ("in", "one of"): `<element id of the property that holds the list>_leaf`. */
    const listBoxId = (f: Figure) => { const h = listHolder(D, f.focus); return iriId(h?.subject.value ?? f.focus.value) + LEAF_SUFFIX; };
    const isList = (f: Figure) => shapeOf(f) === SHN + 'OneOf' || shapeOf(f) === SHN + 'ValueList';
    const isPill = (f: Figure) => shapeOf(f) === SHN + 'Pill';
    /** The diagram id of a box figure. */
    const boxId = (f: Figure) => isPill(f) ? iriId(D.one(f.focus, NS.view + 'of')!.value) + LEAF_SUFFIX
        : isList(f) ? listBoxId(f) : placementId(f);

    const shown = new Map(vf.join.boxes.map(b => [b.figure.id, b]));
    const cards: ElementSchema[] = [], sets: ElementSchema[] = [], leaves: ElementSchema[] = [], edges: ElementSchema[] = [];
    const shapeCards = new Map<string, string>();
    const ids = new Set<string>();
    const latent: { p: PropertyShape; source: string; target: string }[] = [];
    const pending: { p: PropertyShape; source: string; target: string; member: boolean; line: Figure }[] = [];
    const alternatives: { id: string; source: string; target: string }[] = [];
    const lists: ElementSchema[] = [];

    const rowOf = (p: PropertyShape, group?: 'member', tags: string[] = []): ShapeRow & { group?: string } => {
        const relation = p.range.kind === 'node' || p.range.kind === 'class';
        const arrow = relation || p.range.kind === 'scheme' || p.range.kind === 'collection';
        return {
            type: TYPES.ROW, id: p.id, parts: [...tags.map(t => ({ text: t + ' ' })), ...pathParts(p.path)], range: (arrow ? '→ ' : '') + rangeText(shapes, p.range, label),
            style: leafStyle(p.range), card: cardinalityText(p.minCount, p.maxCount), violations: problems.get(p.id) ?? 0, relation, ...(group ? { group } : {})
        };
    };

    // Lines drawn by the view: property edges and alternatives.
    const drawnLines = new Map<string, Figure>();
    for (const l of vf.join.lines) {
        drawnLines.set(l.figure.id, l.figure);
        if (!isShapes(l.figure)) continue;
        if (shapeOf(l.figure) === SHN + 'Alternative') {
            const end = l.end && shown.has(l.end.id) ? boxId(l.end) : undefined;
            if (end) alternatives.push({ id: `${listBoxId(l.start)}_or_${iriId(l.figure.focus.value)}`, source: listBoxId(l.start), target: end });
            continue;
        }
        const p = propertyOf(l.figure, l.start);
        if (!p) continue;
        if (!l.end) continue;
        const target = boxId(l.end);
        pending.push({ p, source: placementId(l.start), target, member: Boolean(l.byHub), line: l.figure });
    }

    for (const b of vf.join.boxes) {
        const f = b.figure, pl = placement(f);
        if (!isShapes(f) && !isValueSets(f)) continue;
        const geometry = { position: { x: pl?.x ?? 0, y: pl?.y ?? 0 } };
        if (shapeOf(f) === SHN + 'Card') {
            const shape = shapes.nodeShapes[iriId(f.focus.value)];
            if (!shape) continue;
            ids.add(shape.id);
            shapeCards.set(shape.id, boxId(f));
            const rows: (ShapeRow & { group?: string })[] = [];
            for (const r of b.rows) {
                const part = r.part;
                if (part?.fs.kind === 'Line' && shapeOf(part) === SHN + 'Property') {
                    const p = propertyOf(part, f);
                    if (!p) continue;
                    rows.push(rowOf(p, undefined, part.tags));
                    // A row whose end is shown: a dashed edge while one of its ends is selected.
                    if (part.end && shown.has(part.end.id)) latent.push({ p, source: boxId(f), target: boxId(part.end) });
                } else if (part?.fs.kind === 'Hub') {
                    const cid = hubConstraintId(vf, part);
                    rows.push({ type: TYPES.ROW, id: cid ?? part.id, parts: [{ text: part.title ?? '' }], range: '', style: 'any', card: '', violations: 0, relation: false, group: 'head' });
                    for (const s of r.sub ?? []) {
                        const p = s.part && propertyOf(s.part, f);
                        if (p) rows.push(rowOf(p, 'member'));
                    }
                }
            }
            const simple = Boolean(pl?.simple);
            const width = pl?.width ?? 300, height = simple ? Math.max(pl?.height ?? 0, SHAPE_CARD.head * scale) : Math.max(pl?.height ?? 0, shapeCardHeight(rows.length, scale));
            const violations = shape.properties.reduce((sum, pid) => sum + (problems.get(pid) ?? 0), 0);
            cards.push({
                type: TYPES.SHAPE, id: boxId(f), element: shape.id, ...geometry, size: { width, height },
                className: 'NodeShape', name: shape.label, subtitle: targetText(shape, shortIri),
                color: pl?.color ?? '', closed: !!shape.closed, violations, display: simple ? 'simple' : 'detailed', hiddenSources: opts.hidden?.shapeSources(shape.id) ?? 0, hiddenTargets: opts.hidden?.neighbors(shape.id)?.targets ?? 0,
                children: simple ? [] : rows as unknown as ElementSchema[]
            });
        } else if (isValueSets(f)) {
            const v = shapes.valueSets[iriId(f.focus.value)];
            if (!v) continue;
            ids.add(v.id);
            const isRow = partIsRow(b);
            const instanceOf = new Map(Object.values(doc.instances).map(i => [i.uri, i.id]));
            const members = v.members.filter(m => isRow(m.uri)).map(m => ({ ...m, instance: instanceOf.get(m.uri) ?? '' }));
            sets.push({
                type: TYPES.VALUESET, id: boxId(f), element: v.id, ...geometry,
                size: { width: pl?.width ?? 320, height: Math.max(pl?.height ?? 0, memberListHeight(members.length, scale)) },
                name: v.label, kind: v.kind, uri: v.uri, members, color: pl?.color ?? ''
            });
        } else if (isList(f)) {
            const holder = listHolder(D, f.focus);
            const p = holder && Object.values(shapes.properties).find(x => x.uri === holder.subject.value);
            if (!p) continue;
            const id = listBoxId(f);
            ids.add(iriId(holder.subject.value));
            if (p.range.kind === 'or') {
                // The alternatives are the list members, in list order (shapes-read.ts).
                const isRow = partIsRow(b), members = D.list(f.focus);
                const rows = alternativeRows(shapes, p, i => isRow(members[i]?.value ?? ''), label);
                lists.push({
                    type: TYPES.ONE_OF, id, ...geometry, size: { width: pl?.width ?? ONE_OF_WIDTH * scale, height: Math.max(pl?.height ?? 0, memberListHeight(rows.length, scale)) },
                    name: `${p.name ?? formatPath(p.path)}: one of`, members: rows
                });
            } else {
                const text = rangeText(shapes, p.range, label);
                leaves.push({ type: TYPES.LEAF, id, ...geometry, size: pillSize(text), text, style: leafStyle(p.range) });
            }
        } else if (isPill(f)) {
            const property = D.one(f.focus, NS.view + 'of');
            const p = Object.values(shapes.properties).find(p => p.uri === property?.value);
            if (!p) continue;
            ids.add(iriId(f.focus.value));
            const text = rangeText(shapes, p.range, label), size = pillSize(text);
            leaves.push({ type: TYPES.LEAF, id: boxId(f), ...geometry,
                size: { width: pl?.width ?? size.width, height: pl?.height ?? size.height }, text, style: leafStyle(p.range) });
        } else if (shapeOf(f) === SHN + 'ClassPill') {
            ids.add(iriId(f.focus.value));
            const text = shortIri(f.focus.value);
            leaves.push({ type: TYPES.LEAF, id: boxId(f), ...geometry, size: pillSize(text), text, style: 'class' });
        }
    }

    // Property lines: one edge for each start card. A member of a shown hub is part of the hub unit.
    const lane = edgeLanes(pending.map(({ source, target }) => [source, target]));
    for (const { p, source, target, member, line } of pending) {
        const pl = placement(line);
        edges.push({
            type: TYPES.PROPERTY, id: p.id, sourceId: source, targetId: target, parts: pathParts(p.path), name: formatPath(p.path),
            card: cardinalityText(p.minCount, p.maxCount), violations: problems.get(p.id) ?? 0, canPutBack: true, member, ...lane(source, target),
            fromSide: pl?.fromSide ?? '', toSide: pl?.toSide ?? '', vertices: pl?.vertices ?? []
        });
    }
    const latentLane = edgeLanes(latent.map(({ source, target }) => [source, target]));
    for (const { p, source, target } of latent) edges.push({
        type: TYPES.LATENT, id: p.id + LATENT_SUFFIX, sourceId: source, targetId: target, parts: pathParts(p.path), name: formatPath(p.path),
        ...latentLane(source, target)
    });
    const alternativeLane = edgeLanes(alternatives.map(a => [a.source, a.target]));
    for (const a of alternatives) edges.push({ type: TYPES.ALTERNATIVE, id: a.id, sourceId: a.source, targetId: a.target, ...alternativeLane(a.source, a.target) });
    // Logical constraints: a hub placement draws its member lines; the client places the circle at the middle of their labels.
    const drawn = new Set(edges.filter(e => e.type === TYPES.PROPERTY).map(e => e.id));
    const logic: ElementSchema[] = [];
    for (const h of vf.join.hubs) {
        if (shapeOf(h) !== SHN + 'Logic') continue;
        const cid = hubConstraintId(vf, h), c = cid ? shapes.constraints[cid] : undefined;
        if (!c) continue;
        logic.push({ type: TYPES.LOGIC, id: c.id, position: { x: 0, y: 0 }, size: { width: 0, height: 0 }, operator: c.operator, members: c.members.filter(m => drawn.has(m)) });
    }
    // Property placements of the view are drawn as lines, not as instance cards.
    for (const [k] of vf.placed) if (k.startsWith('<')) { const id = iriId(k.slice(1, -1)); if (shapes.properties[id] || Object.values(shapes.properties).some(x => x.uri === k.slice(1, -1))) ids.add(id); }
    return { edges, cards: [...cards, ...sets, ...lists], overlays: [...leaves, ...logic], ids };
}

