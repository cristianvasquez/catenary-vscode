// Resolve stored file paths with cross-platform separators; adapted from Catenary packages/rdf-files/src/paths.ts.
import * as nodePath from 'path';


export type PathApi = nodePath.PlatformPath;


/** A relative path from a file, resolved against `dir`. Accepts `\` as separator too (files written by earlier Windows builds). */
export function resolveStored(dir: string, stored: string, p: PathApi = nodePath): string {
    return p.resolve(dir, stored.replace(/\\/g, '/'));
}

