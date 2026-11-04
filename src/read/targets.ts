// SHACL target matches from turtle/query answers, with no kept state: the shapes statements come from the shapes closure, the data from the port.
import type { Quad, Term } from '@rdfjs/types';
import { RDF, RDFS, SH, iri } from '../catenary/contracts/query';
import { NodeReference, readNodeReferences } from '../catenary/shacl/backend/node';
import { focus, term, type QueryTerm, type TargetSelection } from '../catenary/shacl/backend/targets';
import type { FocusNode, TargetKind, TargetMatch, TargetReason } from '../catenary/shacl/common/index';
import { byFile, type ModelPort, type Row } from '../model/port';
import type { ShapesModelRecords } from './shapes';

/** A target declaration of a shape in the closure: `?shape sh:<kind> ?target`, or an implicit class target (target = the shape). */
interface Declaration { shape: string; kind: TargetKind; target: Term }

/** What one call reads once: the data documents, the declarations and the node references of the closure. */
interface Context { port: ModelPort; files: string[]; declarations: Declaration[]; refs: NodeReference[] }

/** The prefix of the IRI that the port gives for a blank node (port.ts, toEngine of model/nquads.ts). */
const BLANK = 'urn:skolem:blank:';

/** Bind only addressable terms. A blank-node label cannot be used in another query. */
export function bindings(variable: string, nodes: readonly FocusNode[]): { clause: string; keep: (t: Term | undefined) => boolean }[] {
    const named = [...new Set(nodes.filter(n => !(n.termType === 'NamedNode' && n.value.startsWith(BLANK))).map(term))];
    return named.length ? [{ clause: `VALUES ?${variable} { ${named.join(' ')} }`, keep: () => true }] : [];
}

/** The VALUES query per file, with its source file on each row. */
export async function boundRows(port: ModelPort, files: string[], variable: string, nodes: readonly FocusNode[], query: (clause: string) => string): Promise<(Row & { file?: string })[]> {
    return (await Promise.all(bindings(variable, nodes).map(async ({ clause }) =>
        await byFile(port, files, query(clause))))).flat();
}

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
    const groups = targetGroups(declarations, 'node');
    const clauses = selection.nodes ? bindings('node', selection.nodes) : [{ clause: '', keep: () => true }];
    if (groups.length) for (const { clause, keep } of clauses) {
        const found = (await c.port.select(`PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}> SELECT ?shape ?node ?kind ?target WHERE {
            { ${groups.join(' UNION ')} } ${clause} }`, c.files)).filter(r => keep(r.node));
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

/** Target patterns binding the requested node variable, optionally including targetNode origins. */
function targetGroups(declarations: Declaration[], variable: string, includeNodes = false): string[] {
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
    if (includeNodes) {
        const nodes = declarations.filter(d => d.kind === 'targetNode').flatMap(d => {
            const t = targetTerm(d.target);
            return t ? [`(${iri(d.shape)} ${t})`] : [];
        });
        if (nodes.length) groups.push(`{ VALUES (?shape ?node) { ${nodes.join(' ')} } }`);
    }
    return groups.map(g => g.replaceAll('?node', `?${variable}`));
}

/** Full reference chains keep every intermediate node inside one answer. */
function chainPattern(chain: NodeReference[], reverse: boolean): string {
    return chain.map((ref, i) => {
        const previous = i ? `?n${i}` : '?origin', next = `?n${i + 1}`;
        return ref.path ? `${reverse ? next : previous} ${ref.path} ${reverse ? previous : next} .` : `BIND (${previous} AS ${next})`;
    }).join(' ');
}

/** Applicable means checked, not conforming. */
async function applicableMatches(c: Context, selection: TargetSelection): Promise<TargetMatch[]> {
    if (selection.nodes?.length === 0 || selection.shapes?.length === 0) return [];
    const refs = c.refs;
    const prefixes = `PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}>`;
    const variables = (chain: NodeReference[]) => chain.map((_, i) => `?n${i + 1}`).join(' ');
    const pattern = (shape: string, variable: string) => targetGroups(c.declarations.filter(d => d.shape === shape), variable, true).join(' UNION ');
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
        type State = { origin: FocusNode; target: string; shape: string; node: FocusNode; chain: NodeReference[]; first?: TargetReason };
        let level: State[] = selection.nodes.filter(n => n.termType === 'NamedNode' && !n.value.startsWith(BLANK))
            .flatMap(origin => targets.map(target => ({ origin, target, shape: target, node: origin, chain: [] })));
        const seen = new Set<string>();
        while (level.length) {
            level = level.filter(({ chain: _chain, ...state }) => { const key = JSON.stringify(state); return !seen.has(key) && !!seen.add(key); });
            for (const s of level) if (s.first && direct.get(JSON.stringify([s.shape, s.node]))) add(s.target, s.origin, [s.first]);
            const steps = new Map<string, { state: State; ref: NodeReference; chain: NodeReference[] }>();
            for (const state of level) for (const ref of refs.filter(r => r.target === state.shape)) {
                const chain = [...state.chain, ref];
                steps.set(JSON.stringify([state.origin, state.target, chain]), { state, ref, chain });
            }
            const next: State[] = [];
            for (const { state, ref, chain } of steps.values()) {
                const endpoint = `n${chain.length}`, target = pattern(ref.source, endpoint);
                const rows = await c.port.select(`${prefixes} SELECT DISTINCT ?origin ${variables(chain)} ?direct WHERE {
                    VALUES ?origin { ${term(state.origin)} } ${chainPattern(chain, true)}
                    BIND (${target ? `EXISTS { ${target} }` : 'false'} AS ?direct) }`, c.files);
                for (const row of rows) {
                    const parent = focus(row[endpoint] as QueryTerm), first = reason(chain[0], focus(row.n1 as QueryTerm));
                    const key = JSON.stringify([ref.source, parent]);
                    direct.set(key, direct.get(key) === true || row.direct.value === 'true');
                    next.push({ origin: state.origin, target: state.target, shape: ref.source, node: parent, first, chain });
                }
            }
            level = next;
        }
    } else if (selection.shapes) {
        const ancestors = new Set(selection.shapes);
        for (let changed = true; changed;) {
            changed = false;
            for (const ref of refs) if (ancestors.has(ref.target) && !ancestors.has(ref.source)) { ancestors.add(ref.source); changed = true; }
        }
        type State = TargetMatch & { originShape: string; chain: NodeReference[] };
        let level: State[] = (await targetMatches(c, { shapes: [...ancestors] })).map(m => ({ ...m, originShape: m.shape, chain: [] }));
        const seen = new Set<string>();
        while (level.length) {
            for (const state of level) add(state.shape, state.node, state.reasons);
            level = level.filter(state => { const key = JSON.stringify([state.shape, state.node]); return !seen.has(key) && !!seen.add(key); });
            const steps = new Map<string, { originShape: string; chain: NodeReference[]; ref: NodeReference }>();
            for (const state of level) for (const ref of refs.filter(r => r.source === state.shape && ancestors.has(r.target))) {
                const chain = [...state.chain, ref];
                steps.set(JSON.stringify([state.originShape, chain]), { originShape: state.originShape, chain, ref });
            }
            const next: State[] = [];
            for (const { originShape, chain, ref } of steps.values()) {
                const target = pattern(originShape, 'origin');
                if (!target) continue;
                const rows = await c.port.select(`${prefixes} SELECT DISTINCT ?shape ?origin ${variables(chain)} WHERE {
                    { ${target} } ${chainPattern(chain, false)} }`, c.files);
                for (const row of rows) next.push({ shape: ref.target, node: focus(row[`n${chain.length}`] as QueryTerm),
                    reasons: [reason(ref, focus(row[chain.length === 1 ? 'origin' : `n${chain.length - 1}`] as QueryTerm))], originShape, chain });
            }
            level = next;
        }
    }
    return [...found.values()].filter(m => !selection.shapes || selection.shapes.includes(m.shape))
        .map(m => ({ ...m, reasons: m.reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
}

/** The order of the old shapeTargetMatches: the shape, then the node as JSON (Intl.Collator). */
const collator = new Intl.Collator();

/**
 * The shapes that apply to the nodes of `selection`, or the nodes that the shapes of `selection` apply to. `modelFiles`: the model
 * documents without the manifest.
 * Nothing is kept between calls.
 */
export async function shapeTargetMatches(port: ModelPort, modelFiles: string[], shapes: ShapesModelRecords, selection: TargetSelection): Promise<TargetMatch[]> {
    const closure = shapes.closure;
    // Read reference structure in one answer: the per-file closure can contain blank labels from different file sets.
    const rows = modelFiles.length ? await port.select('SELECT ?s ?p ?o WHERE { ?s ?p ?o }', modelFiles) : [];
    const refs = closure.length ? readNodeReferences({ select: () => rows }, ['urn:catenary:closure']) : [];
    const c: Context = { port, files: modelFiles, declarations: declarationsOf(closure), refs };
    const nodes = selection.nodes && [...new Map(selection.nodes.map(n => [term(n), n])).values()];
    const matches = await applicableMatches(c, nodes ? { ...selection, nodes } : selection);
    const keyed = matches.map(m => ({ m, node: JSON.stringify(m.node) }));
    keyed.sort((a, b) => collator.compare(a.m.shape, b.m.shape) || collator.compare(a.node, b.node));
    return keyed.map(k => k.m);
}
