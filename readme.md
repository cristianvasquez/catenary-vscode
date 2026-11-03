# Catenary

Catenary draws diagrams of RDF, OWL, SHACL and SKOS models in VS Code. It reads model files through the Turtle RDF language server, stores each diagram as a view file (a `.trig` file with a `view:View`), and exports diagrams into Markdown documents as SVG.

## Requirements

VS Code 1.101 or later and the Turtle RDF language server (`abhishekkundu25.turtle-language-server`). On VS Code, Catenary offers to install it from the Marketplace at first use. On VSCodium and other editors without the Marketplace, install the vsix of your platform from https://github.com/abhishekkundu25/turtle-lsp/releases first.

## Features

- Open a view file (`.trig`) in a custom editor with node shape cards, attribute rows, associations, collections, value sets, instance cards, entity groups, notes, frames and arrows.
- Place, remove, move, resize and color view elements; switch cards between simple and detailed display.
- Remove relation edges from a view, route edges with bends, and change property rows to lines or back to rows.
- Collect instance cards into entity groups and expand them back into cards.
- Edit group labels and note Markdown, add note arrows, and apply Layered or Force layout.
- Navigate to model sources and view references; drop workspace files as references.
- Read model files through turtle-lsp, including labels, prefixes, navigation and SHACL diagnostic badges. Canvas edits write view files only; they do not add or change model statements.
- Embed views in Markdown and export documents with SVG diagrams.
- Out of scope: model explorer, outline, forms, properties panel, model relation editing, a separate SHACL validator or a parser for model files.

## Use

Run Catenary: New View… from the explorer context menu to create a view file, or open an existing view file.

- Open a view file (`.trig`) to display its canvas.
- Click TriG at the right end of the canvas toolbar to open the view file as text; save first if prompted.
- Click Catenary: Open in Canvas in the TriG editor title to return to the canvas; save first if prompted.
- Choose Insert… in the palette or Catenary: Insert Element… in the editor title to place workspace elements that the view does not show.
- Choose Insert… → Link to a file… or Link to a view… to place a file or view reference without dragging.
- Drag a box to move it; drag its resize handle to resize it.
- Click × or press Delete to remove selected elements from the view, not the model.
- Use halo expansion buttons to place hidden neighbours, applicable shapes or checked instances.
- Use a card's halo expand button to show a deleted relation edge again.
- Use halo … → Color to set or clear the selected elements' view color.
- Use halo … → Simple cards or Show details to change selected cards' display.
- Use halo … → Collect to put selected instance cards into an entity group; use Expand to show the cards again.
- Use an entity group's + member input to add an existing instance; use its row × to remove membership from this view.
- Use a row's ➟ to show its element separately or draw a property as a line; use the line's row control to return a property to a row.
- Drag an edge to add a bend, drag a bend to move it, and double-click a bend to remove it.
- Choose Group or Note in the palette and click the canvas to create a view mark.
- Double-click a group label to rename it; double-click a note to edit its Markdown.
- Press Ctrl+Enter or click outside a note editor to commit; press Escape to cancel.
- Drag a note's arrow control to its target to create a view arrow.
- Choose Layout… and then Layered or Force to lay out the view in one undo step.
- Double-click a view or file reference to open it; use the halo's open-in control for a model element's source.
- Drag a workspace file from the explorer onto the canvas to add a file or view reference.
- Use Ctrl+C, Ctrl+X and Ctrl+V to copy or move placements between views; cut alone makes no edit.
- Paste Turtle text to place known workspace subjects; unknown subjects are reported without changing model files.
- Use VS Code Undo, Redo and Save for view edits.
- Run Catenary: Insert View… in Markdown to insert an image whose destination is a view IRI.
- Run Catenary: Export Markdown… from Markdown or the explorer to write documents and diagram SVGs to a destination folder.

VS Code Settings exposes card, group and note font sizes, edge style and vocabulary color. These preferences apply across views; they are not model data.

Set `catenary.sparql.port` to a port over 0 to start a local SPARQL endpoint at `http://127.0.0.1:<port>/sparql` (0 turns it off; Catenary: Start SPARQL Endpoint uses a free port then). It runs SELECT and ASK queries with results in JSON, CSV or TSV, and CONSTRUCT queries with results in N-Triples. Each workspace file is a named graph named by its file URI; the default graph is the union of all files. Browser pages may query it only from the origins listed in `catenary.sparql.allowOrigins` (default empty); curl, scripts and notebooks are not affected. The endpoint needs a Turtle language server with the `turtle/query` request: set `turtle.server.path` to a build of [turtle-lsp, branch turtle-query](https://github.com/cristianvasquez/turtle-lsp/tree/turtle-query) until upstream has it.

## Development

```sh
pnpm install
pnpm build          # dist/extension.js, dist/webview.js
pnpm verify         # typecheck, knip, unit tests and source citation check
pnpm ui             # real mouse and keys in headless VS Code
pnpm ui -- --section bookshop   # one section of the UI checks (model, bookshop)
pnpm ui:markdown    # export a Markdown document with an embedded view
```

### Browser page

`pnpm web:build` writes `dist-web/`, a static site that runs Catenary in the browser tab like the [turtle-lsp browser editor](https://abhishekkundu25.github.io/turtle-lsp/): a file list, Monaco text editors and Catenary canvases. Nothing is uploaded; files stay in the browser's localStorage, and Download writes them as a ZIP file. `pnpm web:serve` serves `dist-web/` at `http://127.0.0.1:8124/`; `pnpm web:ui` checks the page in headless Chromium (`CHROMIUM` sets the binary, default `/usr/bin/chromium`).

The workflow `.github/workflows/pages.yml` publishes `dist-web/` to GitHub Pages on each push to `main`; set the repository's Pages source to "GitHub Actions" once.

- turtle-lsp runs as WebAssembly in a worker. `scripts/fetch-turtle-lsp.mjs` downloads `engine.wasm` and its modules from the turtle-lsp GitHub Pages site and checks the SHA-256 pinned in the script (turtle-lsp 0.13.1). turtle-lsp publishes no versioned web build: when upstream deploys again, a build without the cache in `.cache/turtle-lsp-web/` fails until the pins are updated with `--pin`.
- The GLSP server runs in the page (`src/web/server.ts`), one server instance per canvas over a `MessagePort`. Each canvas is an iframe (`src/web/canvas.ts`), as a VS Code webview is.
- The shared code is not changed for the browser: the web build maps `node:fs`, `node:url`, `node:path` and `node:crypto` to shims (`src/web/shims/`) over an in-memory file system. The SHA-256 shim gives the same placement IRIs as Node.
- `src/model/workspace-core.ts` holds the workspace graph logic of both hosts; `src/node/workspace-model.ts` (VS Code) and `src/web/workspace.ts` (page) supply the graph, the view files and the diagnostics.
- Not in the page: Markdown export, Insert View, New View from a folder, and the Catenary settings (the defaults of `package.json` apply).

The UI scripts build and launch a development host; this repository has no F5 launch configuration. A full `pnpm ui` run takes about 90 s; it stops with a failure after 300 s (`CATENARY_UI_DEADLINE_MS`), and a single Playwright action fails after 15 s. `pnpm package` writes the `.vsix` file.

Rules:
- Copy Catenary's canvas and diagram derivation by dependency; remove model-edit paths and unreachable functions.
- Test this extension's behavior with small unit tests and UI checks; no parity suite against Catenary.
- Use pnpm and lowercase `readme.md`. Keep Markdown prose on one line per paragraph.
