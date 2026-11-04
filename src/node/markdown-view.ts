// The views of view files for Insert View and Export Markdown, from turtle/query: the view files (viewFilesOf) and the view labels (viewLabelsOf).
import { iriId } from '../catenary/model/ids';
import { viewFilesOf } from '../model/view-files';
import type { ModelContext } from '../read/diagram';
import { viewLabelsOf } from '../read/view';

export interface View { iri: string; name?: string }

/** The views of the `.trig` files `trigFiles` (paths) with their files, by file path. A view in two files is in none (viewFilesOf). */
export async function viewsOf(ctx: ModelContext, trigFiles: string[]): Promise<{ file: string; view: View }[]> {
    const { views } = await viewFilesOf(ctx.port, trigFiles), labels = await viewLabelsOf(ctx.port, views, ctx.manifest.language, ctx.viewLabels);
    return [...views].map(([iri, file]) => ({ file, view: { iri, name: labels[iriId(iri)] } }))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
