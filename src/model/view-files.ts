// The view files of a folder, found by turtle/query: a `.trig` document with one subject `?v a view:View`.
import { NS } from '../catenary/model/terms';
import type { ModelPort } from './port';

const VIEWS = `SELECT DISTINCT ?v WHERE { ?v a <${NS.view}View> }`;

/** `views`: view IRI → file path. `skipped`: view files left out, with the reason; they are neither view files nor model files. */
export interface ViewFiles {
    views: Map<string, string>;
    skipped: { file: string; reason: string }[];
}

/**
 * The view files among `trigFiles`. One query per `.trig` file with `files: [file]`: the file is the scope (the server has no named graphs).
 * A file with two or more view:View subjects is skipped with the reason `several views <a>, <b>`. A view IRI in two or more files: every
 * one of these files is skipped with the reason `duplicate view <IRI>`.
 */
export async function viewFilesOf(port: ModelPort, trigFiles: string[]): Promise<ViewFiles> {
    const answers = await Promise.all(trigFiles.map(file => port.select(VIEWS, [file])));
    const filesOf = new Map<string, string[]>(), skipped: ViewFiles['skipped'] = [];
    answers.forEach((rows, i) => {
        const iris = [...new Set(rows.flatMap(({ v }) => v?.termType === 'NamedNode' ? [v.value] : []))].sort();
        if (iris.length > 1) { skipped.push({ file: trigFiles[i], reason: `several views ${iris.map(v => `<${v}>`).join(', ')}` }); return; }
        for (const v of iris) (filesOf.get(v) ?? filesOf.set(v, []).get(v)!).push(trigFiles[i]);
    });
    const views = new Map<string, string>();
    for (const [view, files] of filesOf) {
        if (files.length === 1) views.set(view, files[0]);
        else for (const file of files) skipped.push({ file, reason: `duplicate view ${view}` });
    }
    return { views, skipped };
}

/** The model documents: the RDF documents of the folder that are neither view files nor skipped view files. */
export function modelFilesOf(folderFiles: string[], viewFiles: ViewFiles): string[] {
    const out = new Set([...viewFiles.views.values(), ...viewFiles.skipped.map(s => s.file)]);
    return folderFiles.filter(f => !out.has(f));
}
