// The text and file name of a new empty view file.
import { nameToURI } from 'canonical-md';
import { NS } from '../catenary/model/terms';

/** TriG of a view with no marks: one named graph that holds the view:View and its label. The view IRI is the canonical-md name. */
export function newViewText(name: string): string {
    const iri = `<${nameToURI(name).value}>`;
    return [`@prefix rdfs: <${NS.rdfs}> .`, `@prefix view: <${NS.view}> .`, '', `${iri} {`,
        `  ${iri} a view:View ;`, `    rdfs:label ${JSON.stringify(name)} .`, '}', ''].join('\n');
}

/** `<name>.view.trig`, with the characters that file systems refuse replaced by "-". */
export function viewFileName(name: string): string {
    return `${name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')}.view.trig`;
}
