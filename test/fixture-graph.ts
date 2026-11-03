// The recorded turtle/graph answer of test/fixtures/shapes, with its file:///w/ URIs moved to the fixture folder (graphOf matches view files by path).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GraphResult } from '../src/node/turtle-api';

export const FIXTURE = resolve('test/fixtures/shapes');

export function fixtureGraph(): GraphResult {
    const text = readFileSync(`${FIXTURE}/graph.json`, 'utf8').replaceAll('file:///w/', pathToFileURL(FIXTURE).href + '/');
    return JSON.parse(text).result as GraphResult;
}
