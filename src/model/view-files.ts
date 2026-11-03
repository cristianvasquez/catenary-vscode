// The view files of a folder, found by turtle/query: a `.trig` document with a named graph ?g that has `?g a view:View`.
import { NS } from '../catenary/model/terms';
import type { ModelPort } from './port';

const VIEW_GRAPHS = `SELECT ?g WHERE { GRAPH ?g { ?g a <${NS.view}View> } }`;

/**
 * View IRI → file path. One query per `.trig` file with `files: [file]`: the server names a TriG graph block by its IRI and gives the
 * document no graph of its own, so one query over every `.trig` file cannot tell which file holds a graph. A view IRI in two files: the first file wins.
 */
export async function viewFilesOf(port: ModelPort, trigFiles: string[]): Promise<Map<string, string>> {
    const answers = await Promise.all(trigFiles.map(file => port.select(VIEW_GRAPHS, [file])));
    const views = new Map<string, string>();
    answers.forEach((rows, i) => {
        for (const { g } of rows) if (g?.termType === 'NamedNode' && !views.has(g.value)) views.set(g.value, trigFiles[i]);
    });
    return views;
}

/** The model documents: the RDF documents of the folder that are not view files. */
export function modelFilesOf(folderFiles: string[], viewFiles: Map<string, string>): string[] {
    const views = new Set(viewFiles.values());
    return folderFiles.filter(f => !views.has(f));
}
