// Read vocabulary metadata through RDFS and SHACL providers; adapted from Catenary packages/rdf/src/authoring.ts.
import type { FieldsProvider } from '../contracts/fields';
import type { LinksProvider } from '../contracts/links';
import type { PaletteProvider } from '../contracts/palette';
import type { QueryPort } from '../contracts/query';
import { Classes, mergeContributions } from '../model/metamodel';
import { rdfsFields, rdfsLinks, rdfsPalette } from '../rdfs/domain-range';
import { shaclFields, shaclLinks, shaclPalette } from '../shacl/backend/authoring';
import type { Term } from '@rdfjs/types';
import { ModelGraph } from './graph';
import { REPORT_GRAPH } from './graph-names';
import { labels } from './quad-read';


/** A vocabulary plugin: the graphs it reads and the contracts it gives. A plugin gives the contracts it can. */
interface AuthoringPlugin {
    /** `shapes`: the shapes graphs (the SHACL shapes graph). `files`: all graphs of the files. Never the validation report. */
    reads: 'shapes' | 'files';
    palette?: PaletteProvider;
    links?: LinksProvider;
    fields?: FieldsProvider;
}


/** The plugins, in precedence order: for a class and a predicate, the first plugin that gives a link or a field wins. */
const AUTHORING_PLUGINS: readonly AuthoringPlugin[] = [
    { reads: 'shapes', palette: shaclPalette, links: shaclLinks, fields: shaclFields },
    { reads: 'files', palette: rdfsPalette, links: rdfsLinks, fields: rdfsFields }
];


/** A query port on the graphs of the files, or on `graphs` only. */
function queryPort(g: ModelGraph, graphs?: readonly string[]): QueryPort {
    // `graphs`: VALUES binds the graph first, so the store reads only those graphs (a FILTER would scan the data graphs too).
    const graph = (pattern: string, v = '?g') => graphs ? `VALUES ${v} { ${graphs.map(x => `<${x}>`).join(' ')} } GRAPH ${v} { ${pattern} }`
        : `GRAPH ${v} { ${pattern} } FILTER (${v} != <${REPORT_GRAPH}>)`;
    return {
        select: query => g.select(query) as unknown as Record<string, Term>[],
        graph,
        labels: iris => labels(g, [...iris])
    };
}


/**
 * The metamodel of the plugins on `g`: each reads its graphs (`shapes`: `shapesGraphs`, default the shapes graphs of `g`).
 * `vocabulary`: the SKOS schemes and concepts, for the value sets of the links.
 */
export function authoringMetamodel(g: ModelGraph, vocabulary: Pick<Classes, 'schemes' | 'concepts'>, plugins = AUTHORING_PLUGINS,
    shapesGraphs = g.shapesGraphs().map(t => t.value)): Classes {
    const files = queryPort(g), shapes = queryPort(g, shapesGraphs);
    return mergeContributions(plugins.map(p => {
        const port = p.reads === 'shapes' ? shapes : files;
        const id = p.palette?.id ?? p.links?.id ?? p.fields?.id ?? '';
        return { id, classes: p.palette?.classes(port), links: p.links?.links(port), fields: p.fields?.fields(port) };
    }), vocabulary);
}

