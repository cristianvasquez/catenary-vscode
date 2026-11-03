// The view files of a folder, found by turtle/query: a `.trig` document with a named graph ?g that has `?g a view:View`.
import { NS } from '../catenary/model/terms';
import type { ModelPort } from './port';

const VIEW_GRAPHS = `SELECT ?g WHERE { GRAPH ?g { ?g a <${NS.view}View> } }`;

/** `views`: view IRI → file path. `skipped`: view files left out, with the reason; they are neither view files nor model files. */
export interface ViewFiles {
    views: Map<string, string>;
    skipped: { file: string; reason: string }[];
}

/**
 * The view files among `trigFiles`. One query per `.trig` file with `files: [file]`: the server names a TriG graph block by its IRI and gives the
 * document no graph of its own, so one query over every `.trig` file cannot tell which file holds a graph.
 * A view IRI in two or more files: every one of these files is skipped with the reason `duplicate view <IRI>`.
 */
export async function viewFilesOf(port: ModelPort, trigFiles: string[]): Promise<ViewFiles> {
    const answers = await Promise.all(trigFiles.map(file => port.select(VIEW_GRAPHS, [file])));
    const filesOf = new Map<string, string[]>();
    answers.forEach((rows, i) => {
        for (const { g } of rows) {
            if (g?.termType !== 'NamedNode') continue;
            const files = filesOf.get(g.value) ?? filesOf.set(g.value, []).get(g.value)!;
            if (!files.includes(trigFiles[i])) files.push(trigFiles[i]);
        }
    });
    const views = new Map<string, string>(), skipped: ViewFiles['skipped'] = [];
    for (const [view, files] of filesOf) {
        if (files.length === 1) views.set(view, files[0]);
        else for (const file of files) skipped.push({ file, reason: `duplicate view ${view}` });
    }
    // A file with one unique view and one duplicate view is skipped as a whole.
    const skippedFiles = new Set(skipped.map(s => s.file));
    for (const [view, file] of views) if (skippedFiles.has(file)) views.delete(view);
    return { views, skipped };
}

/** The model documents: the RDF documents of the folder that are neither view files nor skipped view files. */
export function modelFilesOf(folderFiles: string[], viewFiles: ViewFiles): string[] {
    const out = new Set([...viewFiles.views.values(), ...viewFiles.skipped.map(s => s.file)]);
    return folderFiles.filter(f => !out.has(f));
}
