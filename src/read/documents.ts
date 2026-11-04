// Read model statements by document kind, without attributing each answer to a file.
import type { ModelPort, Row } from '../model/port';
import type { ShapesModelRecords } from './shapes';

export type DocumentSets = { shapes: string[]; data: string[] };
export type DocumentRow = Row & { kind: 'shapes' | 'data' };

/** Shapes documents contain at least one subject of the shapes closure; all other model documents are data. */
export function documentSets(shapes: ShapesModelRecords, modelFiles: string[]): DocumentSets {
    return {
        shapes: modelFiles.filter(file => shapes.shapeSubjectsByFile.has(file)),
        data: modelFiles.filter(file => !shapes.shapeSubjectsByFile.has(file)),
    };
}

/** At most two parallel queries. An empty document set must not select the whole workspace. */
export async function byDocumentKind(port: ModelPort, sets: DocumentSets, query: string): Promise<DocumentRow[]> {
    return (await Promise.all((['shapes', 'data'] as const).map(async kind =>
        sets[kind].length ? (await port.select(query, sets[kind])).map(row => ({ ...row, kind }) as DocumentRow) : []))).flat();
}
