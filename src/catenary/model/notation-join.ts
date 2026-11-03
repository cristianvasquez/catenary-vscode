// Join notation figures to placements and determine rows and lines; adapted from Catenary packages/model/src/notation-join.ts.
import { parseVertices } from './doc';
import { Connector, Derivation, Figure, Notations, deriveFigures, termLabel } from './notation';
import { RDF, TripleIndex, V, iri, nkey, triple } from './notation-graph';


/** A placement of a view: its IRI, its display and its geometry (absent on a line, optional on a hub). */
export interface NotationPlacement {
    iri: string; simple: boolean; keptByLines: boolean;
    x?: number; y?: number; width?: number; height?: number; color?: string; fromSide?: string; toSide?: string;
    vertices?: { x: number; y: number }[];
}

/** The placements of a view: placed term key → placement. */
export type Placements = Map<string, NotationPlacement>;


/** The placements of a view: `view:element` (an element) or `rdf:reifies` (a statement). */
export function placementsOf(D: TripleIndex, viewIri: string): Placements {
    const placed: Placements = new Map();
    for (const p of D.subjects(V('view'), iri(viewIri))) {
        const e = D.one(p, V('element')) ?? D.one(p, RDF('reifies'));
        if (!e) continue;
        const num = (l: string) => { const v = D.one(p, V(l)); return v && Number.isFinite(Number(v.value)) ? Number(v.value) : undefined; };
        const str = (l: string) => D.one(p, V(l))?.value;
        const geometry = Object.fromEntries((['x', 'y', 'width', 'height'] as const).map(k => [k, num(k)]).filter(([, v]) => v !== undefined));
        const style = Object.fromEntries((['color', 'fromSide', 'toSide'] as const).map(k => [k, str(k)]).filter(([, v]) => v !== undefined));
        const vertices = parseVertices(str('vertices'));
        placed.set(nkey(e), { iri: p.value, simple: str('display') === 'simple', keptByLines: str('keptByLines') === 'true', ...geometry, ...style, ...(vertices ? { vertices } : {}) });
    }
    return placed;
}


type LineState = 'line' | 'hidden' | 'covered' | undefined;


/** The figures of a view and what the view draws. */
export interface ViewFigures { derivation: Derivation; placed: Placements; join: Join }


/**
 * The figures of a view (`data`: the triples of the workspace) and their join with its placements. `derivation`: the figures of the
 * view from an earlier call, when `data` changed since then only in what the figures do not read.
 */
export function viewFigures(data: TripleIndex, notes: Notations, viewIri: string, derivation = deriveFigures(data, notes, viewIri)): ViewFigures {
    const placed = placementsOf(data, viewIri);
    return { derivation, placed, join: join(derivation, placed) };
}


/** What a set of placements shows. */
function joinState(figs: Figure[], placed: ReadonlyMap<string, unknown>) {
    const isPlaced = (f: Figure) => placed.has(nkey(f.placedAs));
    // An end with several candidates (a class with several node shapes): the first that this view places, else the first.
    for (const f of figs) if (f.ends.length > 1) f.end = f.ends.find(isPlaced) ?? f.ends[0];
    // Rule 7: a Line member is part of the hub unit. A Box member is an end of the hub: it needs its own placement.
    const hubOf = new Map<string, Figure>();
    for (const f of figs) if (f.fs.kind === 'Hub' && isPlaced(f)) for (const m of f.memberFigs) if (m.fs.kind === 'Line') hubOf.set(m.id, f);
    const memo = new Map<string, boolean>();
    const endShown = (f: Figure) => shown(f.end);
    const shown = (f: Figure | undefined): boolean => {
        if (!f) return false;
        if (memo.has(f.id)) return memo.get(f.id)!;
        memo.set(f.id, false);
        let s = false;
        if (f.fs.kind === 'Box') s = isPlaced(f);
        else if (f.fs.kind === 'Line') s = (isPlaced(f) || hubOf.has(f.id)) && endShown(f) && f.starts.some(shown);
        else s = isPlaced(f) && (!f.endValue || shown(f.end))
            && f.memberFigs.every(m => m.fs.kind === 'Line' ? endShown(m) && m.starts.some(shown) : shown(m));
        memo.set(f.id, s);
        return s;
    };
    // nt:covers: a shown hub draws the statement <member> <covered predicate> <end> of each member.
    const covered = new Set<string>();
    for (const f of figs) if (f.covers && f.endValue && shown(f)) for (const m of f.members) covered.add(nkey(triple(m, f.covers, f.endValue)));
    // The figure that a link end shows on: the figure, or a shown box that stands for it (nt:linkEnd, an entity group of a member).
    const linkEnd = (f: Figure | undefined): Figure | undefined => !f ? undefined : shown(f) ? f : f.carriers.find(shown);
    const showsEnd = (f: Figure | undefined) => Boolean(linkEnd(f));
    // Rule 8: a placed statement between two shown figures is a line. Hidden: a dashed line on selection, only when both ends are
    // shown. A statement that a shown hub covers is drawn by the hub. Otherwise the link is a row.
    const lineOf = (c: Connector): LineState => showsEnd(c.start) && showsEnd(c.end) ? (covered.has(nkey(c.statement)) ? 'covered'
        : placed.has(nkey(c.statement)) ? 'line' : c.unplaced === 'Hidden' ? 'hidden' : undefined) : undefined;
    return { isPlaced, hubOf, shown, endShown, covered, lineOf, linkEnd, showsEnd };
}


// --- the join ---------------------------------------------------------------------------------------

/** A row of a box. `connector`: the row stands for a link that is not drawn as a line. */
interface JoinRow { text: string; part?: Figure; connector?: Connector; sub?: JoinRow[]; names?: string[] }

export interface JoinBox { figure: Figure; simple: boolean; rows: JoinRow[] }

interface JoinLine { figure: Figure; start: Figure; end?: Figure; endText: string; byHub?: Figure }

/** A link drawn as a line: its ends are the shown figures (an entity group for a member, nt:linkEnd). */
interface JoinLink { connector: Connector; hidden: boolean; start: Figure; end: Figure }


/** What a view draws. */
interface Join {
    boxes: JoinBox[];
    hubs: Figure[];
    lines: JoinLine[];
    /** A placed Box part, drawn as a part line from its owner (rule 5). */
    parts: { owner: Figure; part: Figure }[];
    links: JoinLink[];
    problems: string[];
}


function join(d: Derivation, placed: Placements): Join {
    const figs = d.figures;
    const { isPlaced, hubOf, shown, lineOf, linkEnd } = joinState(figs, placed);
    const problems: string[] = [];
    for (const f of figs) {
        if (f.fs.kind !== 'Box' && isPlaced(f) && !shown(f)) problems.push(`placement of ${f.id} needs ends that are not shown (rule 6)`);
        if (hubOf.has(f.id) && isPlaced(f)) problems.push(`${f.id} has an own placement and is a member of a placed hub (rule 7)`);
    }
    const known = new Set([...figs.map(f => nkey(f.placedAs)), ...figs.flatMap(f => f.connectors.map(c => nkey(c.statement)))]);
    for (const [k, p] of placed) if (!known.has(k)) problems.push(`placement ${p.iri} places ${k}, which has no figure or connector`);

    // A part is drawn from its owner: a Line that starts at the owner, a shown Hub, or a placed Box (a part line).
    const drawnFrom = (owner: Figure, pf?: Figure) => Boolean(pf && shown(pf) && (pf.fs.kind === 'Line' ? pf.starts.includes(owner) : true));
    const boxes: JoinBox[] = [];
    for (const f of figs.filter(f => shown(f) && f.fs.kind === 'Box')) {
        const visible = (r: { part?: Figure; connector?: Connector }) => !drawnFrom(f, r.part) && !(r.connector && lineOf(r.connector));
        const simple = Boolean(placed.get(nkey(f.placedAs))?.simple);
        const rows: JoinRow[] = simple ? [] : [
            ...f.rows.filter(visible).map(r => ({
                text: r.text, part: r.part, connector: r.connector, ...(r.names ? { names: r.names } : {}),
                ...(r.sub ? { sub: r.sub.filter(visible).map(s => ({ text: s.text, part: s.part, connector: s.connector, ...(s.names ? { names: s.names } : {}) })) } : {})
            })),
            ...f.connectors.filter(c => !c.gathered && !lineOf(c)).map(c => ({ text: c.text, connector: c }))
        ];
        boxes.push({ figure: f, simple, rows });
    }
    const hubs = figs.filter(f => shown(f) && f.fs.kind === 'Hub');
    const lines: JoinLine[] = figs.filter(f => shown(f) && f.fs.kind === 'Line').flatMap(f => f.starts.filter(shown).map(s => ({
        figure: f, start: s, end: f.end,
        endText: f.end?.title ?? (f.endValue ? termLabel(d.data, f.endValue) : f.fs.openEnd ?? ''),
        byHub: hubOf.get(f.id)
    })));
    const parts = figs.filter(f => shown(f)).flatMap(o => o.rows.filter(r => r.part?.fs.kind === 'Box' && shown(r.part)).map(r => ({ owner: o, part: r.part! })));
    const links: JoinLink[] = [], listed = new Set<string>();
    for (const f of figs) for (const c of f.connectors) {
        if (listed.has(nkey(c.statement))) continue;
        listed.add(nkey(c.statement));
        const how = lineOf(c);
        if (how === 'line' || how === 'hidden') links.push({ connector: c, hidden: how === 'hidden', start: linkEnd(c.start)!, end: linkEnd(c.end)! });
    }
    return { boxes, hubs, lines, parts, links, problems };
}


/**
 * The member-list rule, one for every container box: a node shape card, a value set, a "one of" box, an entity group.
 * A part of the box is a row unless the view draws it, as its own box or as a line from the box. `box`: the join box of the container;
 * absent (the view does not draw it with the notation engine): nothing is drawn from it, every part is a row. The test takes the focus
 * IRI of a part.
 */
export function partIsRow(box: JoinBox | undefined): (focus: string) => boolean {
    if (!box) return () => true;
    const focusOf = (rows: { part?: Figure; sub?: { part?: Figure }[] }[]) => new Set(rows.flatMap(r => [r, ...(r.sub ?? [])]).flatMap(r => r.part ? [r.part.focus.value] : []));
    const parts = focusOf(box.figure.rows), rows = focusOf(box.rows);
    return focus => !parts.has(focus) || rows.has(focus);
}


import { NTerm } from './notation-graph';

/**
 * The placed terms (keys) that an arrival of `t` brings with it (rule 11). A user places t (add, drag, paste, expand). Then, until
 * nothing changes: each hub whose ends are all shown, each line with a shown start and end, and each link between two shown figures
 * that no shown hub covers. Only what touches a figure placed by this arrival. The first key is t.
 */
export function arrival(figs: Figure[], placed: Placements, t: NTerm): string[] {
    const after = new Map<string, unknown>(placed), added = [nkey(t)];
    after.set(nkey(t), 'new');
    const touches = (f?: Figure) => Boolean(f && added.includes(nkey(f.placedAs)));
    grow(figs, after, added, touches);
    return added;
}

function grow(figs: Figure[], after: Map<string, unknown>, added: string[], touches: (f?: Figure) => boolean): void {
    const inHub = new Set(figs.filter(f => f.fs.kind === 'Hub').flatMap(h => h.memberFigs.filter(m => m.fs.kind === 'Line').map(m => m.id)));
    for (let changed = true; changed;) {
        changed = false;
        const add = (k: string) => { if (!after.has(k)) { after.set(k, 'new'); added.push(k); changed = true; } };
        let s = joinState(figs, after);
        for (const h of figs.filter(f => f.fs.kind === 'Hub' && !s.isPlaced(f))) {
            const ends = [h.end, ...h.memberFigs.flatMap(m => m.fs.kind === 'Line' ? [m.end, ...m.starts] : [m])];
            const ready = (!h.endValue || s.shown(h.end)) && h.memberFigs.every(m => m.fs.kind === 'Line' ? s.endShown(m) && m.starts.some(s.shown) : s.shown(m));
            if (ready && ends.some(touches)) add(nkey(h.placedAs));
        }
        s = joinState(figs, after);
        for (const l of figs.filter(f => f.fs.kind === 'Line' && !s.isPlaced(f) && !inHub.has(f.id)))
            if (s.shown(l.end) && l.starts.some(s.shown) && [l.end, ...l.starts].some(touches)) add(nkey(l.placedAs));
        s = joinState(figs, after);
        for (const f of figs) for (const c of f.connectors)
            if (s.showsEnd(c.start) && s.showsEnd(c.end) && !s.covered.has(nkey(c.statement)) && (touches(s.linkEnd(c.start)) || touches(s.linkEnd(c.end)))) add(nkey(c.statement));
    }
}


/**
 * The placed terms (keys) that a removal of `t` takes with it: the placements that need a figure that is no longer shown (rule 6),
 * and each box kept by lines (nt:keptByLines, view:keptByLines) whose last line this removal took.
 */
export function removal(figs: Figure[], placed: Placements, t: NTerm): string[] {
    const before = new Map(placed), after = new Map(placed);
    after.delete(nkey(t));
    // What keeps a box: a shown line or hub member line that ends at it. A line that starts at the box (an
    // alternative from its "one of" box) does not keep it.
    const lineEnds = (s: ReturnType<typeof joinState>) => new Set(figs.filter(f => f.fs.kind !== 'Box' && s.shown(f)).flatMap(f => [f.end,
        ...(f.fs.kind === 'Hub' ? f.memberFigs.flatMap(m => m.fs.kind === 'Line' ? [m.end] : [m]) : [])]).filter(Boolean).map(f => f!.id));
    const endsBefore = lineEnds(joinState(figs, before));
    const kept = (f: Figure) => f.fs.keptByLines || Boolean(before.get(nkey(f.placedAs))?.keptByLines);
    for (let changed = true; changed;) {
        changed = false;
        const s = joinState(figs, after);
        for (const f of figs) if (f.fs.kind !== 'Box' && after.has(nkey(f.placedAs)) && !s.shown(f)) { after.delete(nkey(f.placedAs)); changed = true; }
        for (const f of figs) for (const c of f.connectors) if (after.has(nkey(c.statement)) && s.lineOf(c) !== 'line') { after.delete(nkey(c.statement)); changed = true; }
        const endsNow = lineEnds(joinState(figs, after));
        for (const f of figs) if (kept(f) && after.has(nkey(f.placedAs)) && endsBefore.has(f.id) && !endsNow.has(f.id)) { after.delete(nkey(f.placedAs)); changed = true; }
    }
    return [...before.keys()].filter(k => !after.has(k));
}
