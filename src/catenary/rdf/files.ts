// Read workspace manifest settings and file paths, and name the documents of a workspace; adapted from Catenary packages/rdf/src/files.ts.
import { NS } from '../model/terms';
import { VALIDATION_MODES, ValidationMode } from '../model/snapshot';
import type { Quad } from '@rdfjs/types';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'path';
import { rdf } from './terms';

type PathApi = path.PlatformPath;

/** A relative path from a file, resolved against `dir`. Accepts `\` as separator too (files written by earlier Windows builds). */
function resolveStored(dir: string, stored: string, p: PathApi = path): string {
    return p.resolve(dir, stored.replace(/\\/g, '/'));
}

/**
 * The model resource (subject of dct:conformsTo and the label of the model, in the data file), and the graph name of the data in TriG text
 * (workspace files, test fixtures). Files contain this value: do not change it.
 */
export const UNION_GRAPH = 'urn:name:model';

/** The graph of a model document as turtle-lsp names it: its file URI. */
export const dataGraphIri = (file: string) => pathToFileURL(file).href;

/** The file of a document graph (its path), or the graph IRI when it is not a file URI. */
export const fileOfGraph = (graph: string) => {
    if (!graph.startsWith('file:')) return graph;
    try { return fileURLToPath(graph); } catch { return graph; }
};


const WS = {
    Workspace: rdf.namedNode(NS.ws + 'Workspace'),
    /** The file for new subjects when "near" finds no file (see Placement). */
    defaultFile: rdf.namedNode(NS.ws + 'defaultFile'),
    /** Where new shapes, SKOS resources and other subjects go: a file path, or "near" (near their kind). Legacy: "default". */
    placeShapes: rdf.namedNode(NS.ws + 'placeShapes'),
    placeConcepts: rdf.namedNode(NS.ws + 'placeConcepts'),
    placeInstances: rdf.namedNode(NS.ws + 'placeInstances'),
    /** A glob (relative to the workspace folder) of files that are not model files. */
    exclude: rdf.namedNode(NS.ws + 'exclude'),
    /** A glob (relative to the workspace folder) of imported model files: Catenary reads them and does not change them (read only). */
    imported: rdf.namedNode(NS.ws + 'imported'),
    /** What SHACL validation checks: "off", "views" (the elements on the open views) or "all". Not written for "all". */
    validation: rdf.namedNode(NS.ws + 'validation'),
    /** The language of the labels that Catenary shows (a language tag, such as "en"). Not written when not set. */
    language: rdf.namedNode(NS.ws + 'language'),
    /** Whether Catenary commits its writes to git: true turns it on. Not written for false (the default). */
    autoCommit: rdf.namedNode(NS.ws + 'autoCommit'),
    /** Legacy name of ws:imported (read, not written). */
    protect: rdf.namedNode(NS.ws + 'protect')
};


/** SHACL prefix declarations of the manifest: <urn:name:workspace> sh:declare [ sh:prefix "dcat" ; sh:namespace "…"^^xsd:anyURI ]. */
const DECLARE = {
    declare: rdf.namedNode(NS.sh + 'declare'),
    PrefixDeclaration: rdf.namedNode(NS.sh + 'PrefixDeclaration'),
    prefix: rdf.namedNode(NS.sh + 'prefix'),
    namespace: rdf.namedNode(NS.sh + 'namespace'),
    anyURI: rdf.namedNode(NS.xsd + 'anyURI')
};


/** Where new subjects of a kind go: an absolute file path, or `NEAR` (near their kind). */
type Place = string;

const NEAR = 'near';

/** Where new subjects go, by kind. `instances`: every subject that is not a shape or a SKOS resource. */
interface Placement { shapes: Place; concepts: Place; instances: Place }


/**
 * The placement of a kind without a value in the manifest (a manifest before per-kind files, or no manifest): with `ws:defaultFile`,
 * shapes in that file and other subjects near; else all near. "Near" without a near file uses the default file.
 */
const unsetPlacement = (defaultFile?: string): Placement => ({ shapes: defaultFile ?? NEAR, concepts: NEAR, instances: NEAR });


/** The settings that the manifest of the workspace file stores. Absolute paths. */
export interface Manifest {
    /** The file for new subjects when "near" finds no file. Undefined: not set. */
    defaultFile?: string;
    placement: Placement;
    /** Globs, relative to the workspace folder. */
    exclude: string[];
    /** Globs of imported files, relative to the workspace folder. */
    imported: string[];
    /** Prefix table (prefix -> namespace). Undefined: the file declares none; the defaults apply. */
    prefixes?: Record<string, string>;
    /** What SHACL validation checks. Undefined: "all". */
    validation?: ValidationMode;
    /** The language of the labels (ws:language). Undefined: not set. */
    language?: string;
    /** Whether Catenary commits its writes to git (ws:autoCommit). Undefined: false. */
    autoCommit?: boolean;
}


/** Read the manifest graph. Paths are resolved against the directory of the workspace file (`/` or `\` as separator). */
export function readManifest(quads: Quad[], workspaceFile: string, platform: PathApi = path): Manifest {
    const dir = platform.dirname(workspaceFile);
    const values = (p: Quad['predicate']) => quads.filter(q => q.predicate.equals(p) && q.object.termType === 'Literal')
        .map(q => resolveStored(dir, q.object.value, platform)).sort();
    const literals = (p: Quad['predicate']) => quads.filter(q => q.predicate.equals(p) && q.object.termType === 'Literal').map(q => q.object.value);
    const defaultFile = values(WS.defaultFile)[0];
    const unset = unsetPlacement(defaultFile);
    // "near", a path, or the legacy "default" (the default file; without one: near, which uses the proposed default file).
    const place = (p: Quad['predicate'], k: keyof Placement): Place => {
        const v = literals(p)[0];
        if (v === NEAR || (v === 'default' && !defaultFile)) return NEAR;
        if (v === 'default') return defaultFile!;
        return v ? resolveStored(dir, v, platform) : unset[k];
    };
    const prefixes: Record<string, string> = {};
    for (const d of quads.filter(q => q.predicate.equals(DECLARE.declare))) {
        const one = (p: Quad['predicate']) => quads.find(q => q.subject.equals(d.object) && q.predicate.equals(p))?.object.value;
        const prefix = one(DECLARE.prefix), ns = one(DECLARE.namespace);
        if (prefix !== undefined && ns) prefixes[prefix] = ns;
    }
    const validation = literals(WS.validation).find(v => (VALIDATION_MODES as readonly string[]).includes(v)) as ValidationMode | undefined;
    const language = literals(WS.language).map(v => v.trim()).filter(Boolean).sort()[0];
    const autoCommit = literals(WS.autoCommit).includes('true');
    return {
        ...(defaultFile ? { defaultFile } : {}),
        placement: { shapes: place(WS.placeShapes, 'shapes'), concepts: place(WS.placeConcepts, 'concepts'), instances: place(WS.placeInstances, 'instances') },
        exclude: literals(WS.exclude).sort(),
        imported: [...new Set([...literals(WS.imported), ...literals(WS.protect)])].sort(),
        ...(Object.keys(prefixes).length ? { prefixes } : {}),
        ...(validation && validation !== 'all' ? { validation } : {}),
        ...(language ? { language } : {}),
        ...(autoCommit ? { autoCommit } : {})
    };
}

