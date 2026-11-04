// SHACL target matches from turtle/query answers, with no kept state: the shapes statements come from the shapes closure, the data from the port.
import type { Quad, Term } from '@rdfjs/types';
import { RDF, RDFS, SH, iri } from '../catenary/contracts/query';
import { NodeReference, readNodeReferences } from '../catenary/shacl/backend/node';
import { focus, term, type QueryTerm, type TargetSelection } from '../catenary/shacl/backend/targets';
import type { FocusNode, TargetKind, TargetMatch, TargetReason } from '../catenary/shacl/common/index';
import type { ModelPort, Row } from '../model/port';
import type { ShapesModelRecords } from './shapes';

/** A target declaration of a shape in the closure: `?shape sh:<kind> ?target`, or an implicit class target (target = the shape). */
interface Declaration { shape: string; kind: TargetKind; target: Term }

/** What one call reads once: the data documents, the declarations and the node references of the closure. */
interface Context { port: ModelPort; files: string[]; declarations: Declaration[]; refs: NodeReference[] }

/** The prefix of the IRI that the port gives for a blank node (port.ts, toEngine of model/nquads.ts). */
const BLANK = 'urn:skolem:blank:';

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const SKOS_TYPES = new Set(['ConceptScheme', 'Concept', 'Collection'].map(t => SKOS + t));
const SKOS_MEMBERSHIP = new Set(['inScheme', 'topConceptOf'].map(p => SKOS + p));

/** Bind only addressable terms. A blank-node label cannot be used in another query. */
export function bindings(variable: string, nodes: readonly FocusNode[]): { clause: string; keep: (t: Term | undefined) => boolean }[] {
    const named = [...new Set(nodes.filter(n => !(n.termType === 'NamedNode' && n.value.startsWith(BLANK))).map(term))];
    return named.length ? [{ clause: `VALUES ?${variable} { ${named.join(' ')} }`, keep: () => true }] : [];
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
function chainPattern(chain: NodeReference[], reverse: boolean, origin = '?origin'): string {
    return chain.map((ref, i) => {
        const previous = i ? `?n${i}` : origin, next = `?n${i + 1}`;
        return ref.path ? `${reverse ? next : previous} ${ref.path} ${reverse ? previous : next} .` : `BIND (${previous} AS ${next})`;
    }).join(' ');
}

/** Applicable means checked, not conforming. */
async function applicableMatches(c: Context, selection: TargetSelection): Promise<TargetMatch[]> {
    if (selection.nodes?.length === 0 || selection.shapes?.length === 0) return [];
    const refs = c.refs;
    const prefixes = `PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}>`;
    // A level is one UNION answer, so blank intermediates never become query inputs.
    // Only query text size splits a level; submit all of its chunks together.
    const selectLevel = async (steps: { chain: NodeReference[]; body: string }[]): Promise<Row[]> => {
        const encoder = new TextEncoder(), limit = 64 * 1024;
        const queries: string[] = [];
        // Compact IRI tokens, not quoted literals, before applying the byte limit.
        const namespaces = new Map<string, string>();
        const compact = (body: string, used: Set<string>) => body.replace(/"(?:[^"\\]|\\.)*"|<([^<>"{}|^`\\\x00-\x20]*)>|\s+/g, (token, value: string | undefined) => {
            if (value === undefined) return token.startsWith('"') ? token : ' ';
            const split = Math.max(value.lastIndexOf('/'), value.lastIndexOf('#')) + 1;
            const namespace = value.slice(0, split), local = value.slice(split);
            if (!split || !/^[A-Za-z_][A-Za-z0-9_%-]*$/.test(local)) return token;
            const prefix = namespaces.get(namespace) ?? `t${namespaces.size}`;
            namespaces.set(namespace, prefix);
            used.add(namespace);
            return `${prefix}:${local}`;
        });
        const bodies = steps.map(step => {
            const used = new Set<string>();
            return { body: compact(step.body, used), used };
        });
        let branches: string[] = [], bytes = 0, depth = 0, used = new Set<string>();
        const header = (n: number, included = used) => {
            const declarations = [...included].map(namespace => `PREFIX ${namespaces.get(namespace)}: <${namespace}>`).join(' ');
            return `${prefixes} ${declarations} SELECT DISTINCT ?chain ?origin ?direct ${Array.from({ length: n }, (_, i) => `?n${i + 1}`).join(' ')} WHERE { `;
        };
        const flush = () => {
            if (branches.length) queries.push(`${header(depth)}${branches.join(' UNION ')} }`);
            branches = []; bytes = 0; depth = 0; used = new Set();
        };
        for (const [index, step] of steps.entries()) {
            const branch = `{ BIND (${index} AS ?chain) ${bodies[index].body} }`;
            const size = encoder.encode(branch).length;
            const nextDepth = Math.max(depth, step.chain.length);
            const included = new Set([...used, ...bodies[index].used]);
            if (branches.length && encoder.encode(header(nextDepth, included)).length + bytes + 7 + size + 2 > limit) flush();
            for (const namespace of bodies[index].used) used.add(namespace);
            depth = Math.max(depth, step.chain.length);
            if (encoder.encode(header(depth)).length + size + 2 > limit) throw new Error('Target reference chain exceeds 64 KB query limit');
            bytes += (branches.length ? 7 : 0) + size;
            branches.push(branch);
        }
        flush();
        return (await Promise.all(queries.map(query => c.port.select(query, c.files)))).flat();
    };
    // Reference walks need only target membership, not declaration metadata.
    const pattern = (shape: string, variable: string) => [...new Set(c.declarations.filter(d => d.shape === shape).flatMap(d => {
        const target = targetTerm(d.target);
        if (!target) return [];
        const node = `?${variable}`;
        switch (d.kind) {
            case 'targetClass': case 'implicitClass': return [`{ ${node} rdf:type/rdfs:subClassOf* ${target} . }`];
            case 'targetSubjectsOf': return [`{ ${node} ${target} ?object . }`];
            case 'targetObjectsOf': return [`{ ?subject ${target} ${node} . }`];
            case 'targetNode': return [`{ VALUES ${node} { ${target} } }`];
        }
    }))].join(' UNION ');
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
                steps.set(JSON.stringify([state.origin, chain]), { state, ref, chain });
            }
            const next: State[] = [];
            const chains = [...steps.values()];
            const rows = await selectLevel(chains.map(({ state, ref, chain }) => {
                const target = pattern(ref.source, `n${chain.length}`);
                return { chain, body: `${chainPattern(chain, true, term(state.origin))}
                    ${target ? `BIND (EXISTS { ${target} } AS ?direct)` : ''}` };
            }));
            for (const row of rows) {
                const { state, ref, chain } = chains[Number(row.chain.value)];
                const parent = focus(row[`n${chain.length}`] as QueryTerm), first = reason(chain[0], focus(row.n1 as QueryTerm));
                const key = JSON.stringify([ref.source, parent]);
                direct.set(key, direct.get(key) === true || row.direct?.value === 'true');
                next.push({ origin: state.origin, target: state.target, shape: ref.source, node: parent, first, chain });
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
            const chains = [...steps.values()].flatMap(step => {
                const target = pattern(step.originShape, 'origin');
                return target ? [{ ...step, body: `{ ${target} } ${chainPattern(step.chain, false)}` }] : [];
            });
            const rows = await selectLevel(chains);
            for (const row of rows) {
                const { originShape, chain, ref } = chains[Number(row.chain.value)];
                next.push({ shape: ref.target, node: focus(row[`n${chain.length}`] as QueryTerm),
                    reasons: [reason(ref, focus(row[chain.length === 1 ? 'origin' : `n${chain.length - 1}`] as QueryTerm))], originShape, chain });
            }
            level = next;
        }
    }
    return [...found.values()].filter(m => !selection.shapes || selection.shapes.includes(m.shape))
        .map(m => ({ ...m, reasons: m.reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
}

/** The target badges of a view: per placed node shape, its targets that the view does not show; per card IRI, the node shapes that target it and that the view does not show. */
export interface TargetBadges { shapes: Map<string, number>; nodes: Map<string, number> }

/**
 * The target badges (TargetBadges) from the direct target declarations of the closure (sh:targetClass with rdfs:subClassOf*, implicit
 * class, sh:targetSubjectsOf, sh:targetObjectsOf, sh:targetNode), one COUNT query each: the instances that each placed shape targets,
 * `placedIris` excluded in the query; the node shapes of the model that are not placed and target each of `placedIris`. An instance has
 * an rdf:type or rdfs:label statement that the shapes closure does not hold, unless it is a SKOS subject of the shapes (isInstance of
 * choices.ts). The sh:node walk (applicableMatches) is not run: it is for the targets picker only. Two queries at most.
 */
export async function targetBadges(port: ModelPort, modelFiles: string[], shapes: ShapesModelRecords, placedShapes: string[], placedIris: string[]): Promise<TargetBadges> {
    const badges: TargetBadges = { shapes: new Map(), nodes: new Map() };
    if (!modelFiles.length) return badges;
    const declarations = declarationsOf(shapes.closure), placed = new Set(placedShapes);
    const nodeShapes = new Set(Object.values(shapes.index.model.nodeShapes).map(s => s.uri));
    const named = [...new Set(placedIris)].filter(v => !v.startsWith(BLANK)).flatMap(v => { try { return [iri(v)]; } catch { return []; } });
    const prefixes = `PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}>`;
    // The rdf:type and rdfs:label statements of the shapes subjects that are not SKOS subjects: they do not make an instance.
    const vocabulary = new Set(shapes.closure.filter(q => (q.predicate.value === RDF + 'type' && SKOS_TYPES.has(q.object.value)) || SKOS_MEMBERSHIP.has(q.predicate.value)).map(q => q.subject.value));
    const shapesOnly = [...new Set(shapes.closure.flatMap(q => {
        if (q.subject.termType !== 'NamedNode' || q.subject.value.startsWith(BLANK) || vocabulary.has(q.subject.value)) return [];
        if (q.predicate.value !== RDF + 'type' && q.predicate.value !== RDFS + 'label') return [];
        const o = q.object.termType === 'NamedNode' || q.object.termType === 'Literal' ? targetTerm(q.object) : undefined;
        return o ? [`(${iri(q.subject.value)} ${iri(q.predicate.value)} ${o})`] : [];
    }))];
    const notShapes = shapesOnly.length ? ` FILTER NOT EXISTS { VALUES (?cn ?cp ?co) { ${shapesOnly.join(' ')} } FILTER (sameTerm(?cn, ?node) && sameTerm(?cp, ?tp) && sameTerm(?co, ?tv)) }` : '';
    const instance = `FILTER EXISTS { VALUES ?tp { rdf:type rdfs:label } ?node ?tp ?tv${notShapes} }`;
    const count = async (into: Map<string, number>, group: 'shape' | 'node', chosen: Declaration[], where: string) => {
        const groups = targetGroups(chosen, 'node', true);
        if (!groups.length) return;
        const counted = group === 'shape' ? 'node' : 'shape';
        const rows = await port.select(`${prefixes} SELECT ?${group} (COUNT(DISTINCT ?${counted}) AS ?n) WHERE { ${where.replace('$', `{ ${groups.join(' UNION ')} }`)} } GROUP BY ?${group}`, modelFiles);
        for (const r of rows) if (r[group] && r.n) into.set(r[group].value, Number(r.n.value));
    };
    await Promise.all([
        placed.size ? count(badges.shapes, 'shape', declarations.filter(d => placed.has(d.shape)),
            `$ FILTER (isIRI(?node)${named.length ? ` && ?node NOT IN (${named.join(', ')})` : ''}) ${instance}`) : undefined,
        named.length ? count(badges.nodes, 'node', declarations.filter(d => nodeShapes.has(d.shape) && !placed.has(d.shape)), `VALUES ?node { ${named.join(' ')} } $`) : undefined,
    ]);
    return badges;
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
