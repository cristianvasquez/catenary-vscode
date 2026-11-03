// The view documents of a fixture folder on a test server, as an editor holds them: a command runs through runCommand and its edits reach
// the server as didChange, so that the next query reads the new text. The test side of the VS Code host (model/workspace-core.ts).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ViewCommand } from '../src/catenary/model/commands';
import { type CommandRun, runCommand } from '../src/edit/executor';
import { rdf, tripleKey } from '../src/edit/terms';
import { ViewQuads } from '../src/edit/view-quads';
import type { ModelContext } from '../src/read/diagram';
import type { startServer } from './server';

type Server = Awaited<ReturnType<typeof startServer>>;

export interface ViewDocuments {
    /** Every view document back to the text of its file. */
    reset(): void;
    /** The quads of the view graph `iri` as the server has them. */
    quads(iri: string): Promise<ViewQuads>;
    /** The sorted statement keys of the view graph `iri` as the server has them. */
    keys(iri: string): Promise<string[]>;
    /** A new text of the view document of `iri`, sent to the server. */
    set(iri: string, text: string): void;
    /** The text of the view document of `iri`. */
    text(iri: string): string;
    /** One command on the views `iris` (default: every view); the edits are applied. */
    run(command: ViewCommand, iris?: string[]): Promise<CommandRun>;
}

/** `files`: view IRI → file path. The documents are opened on the server with the text of their files. */
export function viewDocuments(server: Server, ctx: () => ModelContext, files: Record<string, string>): ViewDocuments {
    const uri = (iri: string) => pathToFileURL(files[iri]).href, texts = new Map<string, string>();
    const docs: ViewDocuments = {
        reset() {
            for (const iri of Object.keys(files)) docs.set(iri, readFileSync(files[iri], 'utf8'));
        },
        async quads(iri) {
            const g = rdf.namedNode(iri);
            const rows = await server.port().select(`SELECT ?s ?p ?o WHERE { GRAPH <${iri}> { ?s ?p ?o } }`);
            return new ViewQuads(rows.map(r => rdf.quad(r.s as never, r.p as never, r.o as never, g)), g);
        },
        async keys(iri) {
            return (await docs.quads(iri)).quads().map(tripleKey).sort();
        },
        set(iri, text) {
            texts.set(iri, text);
            server.change(uri(iri), text);
        },
        text: iri => texts.get(iri)!,
        async run(command, iris = Object.keys(files)) {
            const r = await runCommand(ctx(), iris.map(iri => ({ iri, uri: uri(iri), text: texts.get(iri) })), command);
            for (const e of r.edits) docs.set(iris.find(i => uri(i) === e.uri)!, e.text);
            return r;
        }
    };
    for (const iri of Object.keys(files)) {
        texts.set(iri, readFileSync(files[iri], 'utf8'));
        server.open(uri(iri), texts.get(iri)!, 'trig');
    }
    return docs;
}
