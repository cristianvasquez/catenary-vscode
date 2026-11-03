// The workspace manifest (the ws:Workspace document) from turtle/query: its prefixes and the language of the labels.
import type { Quad } from '@rdfjs/types';
import { DEFAULT_PREFIXES, setPrefixes } from '../catenary/model/shapes-doc';
import { NS } from '../catenary/model/terms';
import { readManifest } from '../catenary/rdf/files';
import { dataGraphIri } from '../catenary/rdf/files';
import { readLegacy } from '../catenary/rdf/loader';
import { rdf } from '../catenary/rdf/terms';
import { byFile, type ModelPort } from '../model/port';

/** `file`: the path of the manifest document; undefined: the model files have none. */
export interface ManifestRecords {
    file?: string;
    prefixes?: Record<string, string>;
    language?: string;
}

// The legacy namespace of ws: too (LEGACY_NAMESPACES of model/terms.ts): a manifest in an old namespace is a manifest.
const MANIFEST = `SELECT ?s ?p ?o WHERE { ?w a ?t . VALUES ?t { <${NS.ws}Workspace> <osg://vocab/workspace#Workspace> } ?s ?p ?o }`;

/**
 * The manifest among `modelFiles`: every statement of each document with a ws:Workspace (one query per document, byFile); the first
 * document by path wins. Its blank nodes (sh:declare) come from the answer of that one document.
 */
export async function manifestOf(port: ModelPort, modelFiles: string[]): Promise<ManifestRecords> {
    const docs = new Map<string, Quad[]>();
    for (const { file, s, p, o } of await byFile(port, modelFiles, MANIFEST)) {
        (docs.get(file) ?? docs.set(file, []).get(file)!).push(rdf.quad(s as Quad['subject'], p as Quad['predicate'], o as Quad['object'], rdf.namedNode(dataGraphIri(file))));
    }
    const file = [...docs.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[0];
    if (file === undefined) return {};
    const { prefixes, language } = readManifest(readLegacy(docs.get(file)!).quads, file);
    return { file, ...(prefixes ? { prefixes } : {}), ...(language ? { language } : {}) };
}

/** Sets the prefix table of compactIri and shortIri: the manifest's, else the defaults */
export function applyPrefixes(manifest: ManifestRecords): void {
    setPrefixes(manifest.prefixes ?? DEFAULT_PREFIXES);
}
