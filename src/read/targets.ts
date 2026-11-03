// SHACL target matches from turtle/query answers, with no kept state: the shapes statements come from the shapes closure, the data from the port.
import type { Quad, Term } from '@rdfjs/types';
import { RDF, RDFS, SH, iri } from '../catenary/contracts/query';
import { NodeReference, readNodeReferences } from '../catenary/shacl/backend/node';
import { focus, term, type QueryTerm, type TargetSelection } from '../catenary/shacl/backend/targets';
import type { FocusNode, TargetKind, TargetMatch, TargetReason } from '../catenary/shacl/common/index';
import type { ModelPort } from '../model/port';
import type { ShapesModelRecords } from './shapes';

/** A target declaration of a shape in the closure: `?shape sh:<kind> ?target`, or an implicit class target (target = the shape). */
interface Declaration { shape: string; kind: TargetKind; target: Term }

/** What one call reads once: the data documents, the declarations and the node references of the closure. */
interface Context { port: ModelPort; files: string[]; declarations: Declaration[]; refs: NodeReference[] }

const DECLARED: Record<string, TargetKind> = Object.fromEntries((['targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf'] as const).map(k => [SH + k, k]));

/** The target declarations of the closure. Implicit class: a shape typed sh:NodeShape and rdfs:Class in the same document. */
function declarationsOf(closure: readonly Quad[]): Declaration[] {
    const out: Declaration[] = [], types = new Map<string, { shape: Term; types: Set<string> }>();
    for (const q of closure) {
        if (q.subject.termType !== 'NamedNode') continue;
        const kind = DECLARED[q.predicate.value];
        if (kind) out.push({ shape: q.subject.value, kind, target: q.object });
        if (q.predicate.value === RDF + 'type') {
            const key = JSON.stringify([q.graph.value, q.subject.value]);
            (types.get(key) ?? types.set(key, { shape: q.subject, types: new Set() }).get(key)!).types.add(q.object.value);
        }
    }
    for (const { shape, types: t } of types.values()) if (t.has(SH + 'NodeShape') && t.has(RDFS + 'Class')) out.push({ shape: shape.value, kind: 'implicitClass', target: shape });
    return out;
}

/** The SPARQL text of a declared target, or undefined for a term that a query cannot name. */
function targetTerm(t: Term): string | undefined {
    try { return term(focus(t as QueryTerm)); } catch { return undefined; }
}

/**
 * The direct target matches (targetMatches of shacl/backend/targets.ts): the declarations in memory, one data query for the class,
 * subjects-of and objects-of targets, sh:targetNode without a query.
 */
async function targetMatches(c: Context, selection: TargetSelection): Promise<TargetMatch[]> {
    if (!c.files.length || selection.nodes?.length === 0 || selection.shapes?.length === 0) return [];
    const shapes = selection.shapes && new Set(selection.shapes);
    const declarations = c.declarations.filter(d => !shapes || shapes.has(d.shape));
    const rows: { shape: string; node: FocusNode; kind: TargetKind; target: FocusNode }[] = [];
    const values = (kinds: TargetKind[]) => declarations.filter(d => kinds.includes(d.kind)).flatMap(d => {
        const t = targetTerm(d.target);
        return t ? [`(${iri(d.shape)} ${JSON.stringify(d.kind)} ${t})`] : [];
    });
    const branches = [
        [['targetClass', 'implicitClass'], '?node rdf:type/rdfs:subClassOf* ?target .'],
        [['targetSubjectsOf'], '?node ?target ?object .'],
        [['targetObjectsOf'], '?subject ?target ?node .'],
    ] as const;
    const groups = branches.flatMap(([kinds, pattern]) => {
        const v = values([...kinds]);
        return v.length ? [`{ VALUES (?shape ?kind ?target) { ${v.join(' ')} } ${pattern} }`] : [];
    });
    if (groups.length) {
        const found = await c.port.select(`PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}> SELECT ?shape ?node ?kind ?target WHERE {
            ${selection.nodes ? `VALUES ?node { ${selection.nodes.map(term).join(' ')} }` : ''}
            { ${groups.join(' UNION ')} } }`, c.files);
        for (const r of found) rows.push({ shape: r.shape.value, node: focus(r.node as QueryTerm), kind: r.kind.value as TargetKind, target: focus(r.target as QueryTerm) });
    }
    const wanted = selection.nodes && new Set(selection.nodes.map(term));
    for (const d of declarations.filter(d => d.kind === 'targetNode')) {
        const t = targetTerm(d.target);
        if (!t || (wanted && !wanted.has(t))) continue;
        const node = focus(d.target as QueryTerm);
        rows.push({ shape: d.shape, node, kind: d.kind, target: node });
    }
    const result = new Map<string, TargetMatch>();
    for (const row of rows) {
        const key = JSON.stringify([row.shape, row.node]);
        const match = result.get(key) ?? { shape: row.shape, node: row.node, reasons: [] };
        if (!match.reasons.some(r => r.kind === row.kind && JSON.stringify(r.target) === JSON.stringify(row.target))) match.reasons.push({ kind: row.kind, target: row.target });
        result.set(key, match);
    }
    for (const match of result.values()) match.reasons.sort((a, b) => a.kind.localeCompare(b.kind) || JSON.stringify(a.target).localeCompare(JSON.stringify(b.target)));
    return [...result.values()].sort((a, b) => a.shape.localeCompare(b.shape) || JSON.stringify(a.node).localeCompare(JSON.stringify(b.node)));
}

/** The values of `predicates` from each of `nodes` (reverse: to each of `nodes`): one CONSTRUCT on the port. */
async function traverse(c: Context, nodes: readonly FocusNode[], predicates: readonly string[], reverse: boolean): Promise<{ node: FocusNode; predicate: string; value: FocusNode }[]> {
    const byTerm = new Map(nodes.map(n => [term(n), n]));
    const values = `VALUES ?node { ${[...byTerm.keys()].join(' ')} } VALUES ?p { ${predicates.map(iri).join(' ')} }`;
    const pattern = reverse ? '?value ?p ?node' : '?node ?p ?value';
    const quads = await c.port.construct(`CONSTRUCT { ${pattern} } WHERE { ${values} ${pattern} }`, c.files);
    const out: { node: FocusNode; predicate: string; value: FocusNode }[] = [];
    for (const q of quads) {
        const [n, v] = reverse ? [q.object, q.subject] : [q.subject, q.object];
        if (v.termType !== 'NamedNode' && v.termType !== 'Literal') continue;
        const key = targetTerm(n), node = key && byTerm.get(key);
        if (node) out.push({ node, predicate: q.predicate.value, value: focus(v as QueryTerm) });
    }
    return out;
}

/** applicableMatches of shacl/backend/node.ts with an asynchronous select and traverse. Applicable means checked, not conforming. */
async function applicableMatches(c: Context, selection: TargetSelection): Promise<TargetMatch[]> {
    if (selection.nodes?.length === 0 || selection.shapes?.length === 0) return [];
    const refs = c.refs;
    const paths = new Map<string, FocusNode[]>();
    const fetch = async (wanted: readonly { ref: NodeReference; node: FocusNode }[], reverse: boolean) => {
        const byPath = new Map<string, Map<string, FocusNode>>();
        for (const { ref, node } of wanted) {
            if (!ref.path || paths.has(JSON.stringify([ref.path, node, reverse]))) continue;
            const nodes = byPath.get(ref.path) ?? byPath.set(ref.path, new Map()).get(ref.path)!;
            nodes.set(JSON.stringify(node), node);
        }
        const simple = [...byPath].filter(([path]) => /^<[^<>]*>$|^\(<[^<>]*>(?:\|<[^<>]*>)+\)$/.test(path));
        const nodes = [...new Map(simple.flatMap(([, group]) => [...group].map(([key, node]) => [key, node] as const))).values()];
        const predicates = new Map<string, string[]>();
        for (const [path, group] of simple) {
            for (const predicate of path.replace(/^\(|\)$/g, '').split('|').map(p => p.slice(1, -1)))
                predicates.set(predicate, [...predicates.get(predicate) ?? [], path]);
            for (const node of group.values()) paths.set(JSON.stringify([path, node, reverse]), []);
        }
        if (nodes.length) for (const row of await traverse(c, nodes, [...predicates.keys()], reverse)) {
            for (const path of predicates.get(row.predicate) ?? []) {
                const key = JSON.stringify([path, row.node, reverse]), values = paths.get(key);
                if (values && !values.some(v => JSON.stringify(v) === JSON.stringify(row.value))) values.push(row.value);
            }
        }
        for (const [path] of simple) byPath.delete(path);
        for (const [path, nodes] of byPath) {
            for (const node of nodes.values()) paths.set(JSON.stringify([path, node, reverse]), []);
            const seen = new Set<string>();
            for (const r of await c.port.select(`SELECT ?node ?value WHERE { VALUES ?node { ${[...nodes.values()].map(term).join(' ')} }
                ${reverse ? `?value ${path} ?node` : `?node ${path} ?value`} }`, c.files)) {
                const node = focus(r.node as QueryTerm), value = focus(r.value as QueryTerm), key = JSON.stringify([path, node, reverse]);
                if (seen.has(key + JSON.stringify(value))) continue;
                seen.add(key + JSON.stringify(value));
                paths.get(key)!.push(value);
            }
        }
    };
    const values = (ref: NodeReference, node: FocusNode, reverse: boolean): FocusNode[] =>
        ref.path ? paths.get(JSON.stringify([ref.path, node, reverse]))! : [node];
    const reason = (ref: NodeReference, sourceNode: FocusNode): TargetReason => ({
        kind: 'node', target: { termType: 'NamedNode', value: ref.target }, sourceShape: ref.source, sourceNode,
        ...(ref.property ? { property: ref.property } : {})
    });
    const found = new Map<string, TargetMatch>();
    const add = (shape: string, node: FocusNode, reasons: TargetReason[]) => {
        const key = JSON.stringify([shape, node]), match = found.get(key) ?? { shape, node, reasons: [] };
        for (const r of reasons) if (!match.reasons.some(x => JSON.stringify(x) === JSON.stringify(r))) match.reasons.push(r);
        found.set(key, match);
    };
    if (selection.nodes) {
        for (const direct of await targetMatches(c, selection)) add(direct.shape, direct.node, direct.reasons);
        const targets = [...new Set(refs.map(r => r.target))].filter(s => !selection.shapes || selection.shapes.includes(s));
        const direct = new Map<string, boolean>();
        type State = { origin: FocusNode; target: string; shape: string; node: FocusNode; first?: TargetReason };
        let level: State[] = selection.nodes.flatMap(origin => targets.map(target => ({ origin, target, shape: target, node: origin })));
        const seen = new Set<string>();
        while (level.length) {
            level = level.filter(state => { const key = JSON.stringify(state); return !seen.has(key) && !!seen.add(key); });
            const open = level.filter(s => s.first && !direct.has(JSON.stringify([s.shape, s.node])));
            if (open.length) {
                const shapes = [...new Set(open.map(s => s.shape))], nodes = [...new Map(open.map(s => [JSON.stringify(s.node), s.node])).values()];
                for (const s of open) direct.set(JSON.stringify([s.shape, s.node]), false);
                for (const m of await targetMatches(c, { nodes, shapes })) direct.set(JSON.stringify([m.shape, m.node]), true);
            }
            for (const s of level) if (s.first && direct.get(JSON.stringify([s.shape, s.node]))) add(s.target, s.origin, [s.first]);
            const steps = level.flatMap(state => refs.filter(r => r.target === state.shape).map(ref => ({ state, ref, node: state.node })));
            await fetch(steps, true);
            level = steps.flatMap(({ state, ref }) => values(ref, state.node, true).map(parent =>
                ({ origin: state.origin, target: state.target, shape: ref.source, node: parent, first: state.first ?? reason(ref, parent) })));
        }
    } else if (selection.shapes) {
        const ancestors = new Set(selection.shapes);
        for (let changed = true; changed;) {
            changed = false;
            for (const ref of refs) if (ancestors.has(ref.target) && !ancestors.has(ref.source)) { ancestors.add(ref.source); changed = true; }
        }
        let level = await targetMatches(c, { shapes: [...ancestors] });
        const seen = new Set<string>();
        while (level.length) {
            for (const state of level) add(state.shape, state.node, state.reasons);
            level = level.filter(state => { const key = JSON.stringify([state.shape, state.node]); return !seen.has(key) && !!seen.add(key); });
            const steps = level.flatMap(state => refs.filter(r => r.source === state.shape && ancestors.has(r.target)).map(ref => ({ state, ref, node: state.node })));
            await fetch(steps, false);
            level = steps.flatMap(({ state, ref }) => values(ref, state.node, false).map(node => ({ shape: ref.target, node, reasons: [reason(ref, state.node)] })));
        }
    }
    return [...found.values()].filter(m => !selection.shapes || selection.shapes.includes(m.shape))
        .map(m => ({ ...m, reasons: m.reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
}

/** The order of the old shapeTargetMatches: the shape, then the node as JSON (Intl.Collator). */
const collator = new Intl.Collator();

/**
 * The shapes that apply to the nodes of `selection`, or the nodes that the shapes of `selection` apply to (applicableMatches), as
 * shapeTargetMatches of rdf/shacl-targets.ts. `modelFiles`: the model documents without the manifest (the data of the old store).
 * Nothing is kept between calls.
 */
export async function shapeTargetMatches(port: ModelPort, modelFiles: string[], shapes: ShapesModelRecords, selection: TargetSelection): Promise<TargetMatch[]> {
    const closure = shapes.closure;
    // The rows of readNodeReferences: every shapes statement, from the closure, not from a query.
    const rows = closure.map(q => ({ s: q.subject, p: q.predicate, o: q.object }) as Record<string, QueryTerm>);
    const refs = closure.length ? readNodeReferences({ select: () => rows }, ['urn:catenary:closure']) : [];
    const c: Context = { port, files: modelFiles, declarations: declarationsOf(closure), refs };
    const nodes = selection.nodes && [...new Map(selection.nodes.map(n => [term(n), n])).values()];
    const matches = await applicableMatches(c, nodes ? { ...selection, nodes } : selection);
    const keyed = matches.map(m => ({ m, node: JSON.stringify(m.node) }));
    keyed.sort((a, b) => collator.compare(a.m.shape, b.m.shape) || collator.compare(a.node, b.node));
    return keyed.map(k => k.m);
}
