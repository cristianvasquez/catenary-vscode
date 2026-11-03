# Changelog

## Unreleased

- Local SPARQL endpoint at `http://127.0.0.1:<port>/sparql` over the workspace through the Turtle language server `turtle/query` request: setting `catenary.sparql.port`, commands Start, Stop and Copy SPARQL Endpoint URL, a status bar item, and browser pages from the origins in `catenary.sparql.allowOrigins`.
- The workspace graph is read without a layout and loaded in bulk as N-Quads. On a 20k-triple workspace the refresh went from about 5.6 s to under 1 s (754 ms + 4.8 s before; 116 ms + about 0.5 s after).
- The store graph of a model file is its file URI, and its shapes are in `<file URI>#shapes` (was `urn:data:` / `urn:shapes:`).
- The canvas draws from `turtle/query` of the Turtle language server (fork `cristianvasquez/turtle-lsp`, branch `turtle-query`): no model copy for the drawing. A change of an open model document redraws the canvas before a save. The browser page still draws from the old graph.
- The canvas is a text editor of the view `.trig` file: a canvas edit is one text edit of the file, and undo, redo, the unsaved state, save, revert and backup are VS Code's. A change of the file in a text editor redraws the canvas. The canvas and the text editor switch without a save. A paste of a cut from another view edits both view files (one undo step in each). Until the engine of the browser page answers `turtle/query`, its canvas is read-only.

## 0.0.3

- A click on the red violation badge of a card shows the problem (hover text: "Show the problem: <message>").
- Insert: "Link to a file…" and "Link to a view…" act at once and open the file or view picker. In the browser page they have no check box, and linking works again (the picker closed without making the link).
- A view file is any `.trig` file with a `view:View`; the `.view.trig` ending is no longer required. New views are saved as `<name>.trig`. A `.trig` file without a view opens in the text editor.
- Browser page sample: flat file names (`data.ttl`, `shapes.ttl`, `cities.ttl`, `prefixes.ttl`, `model.trig`, `instances.trig`), and one SHACL error on purpose (Animal Farm).

## 0.0.2

- The Turtle RDF language server is no longer a hard dependency: Catenary offers to install it at first use, so the package installs on Open VSX editors too.
- Browser page: closing a text tab with unsaved changes asks first; a save that cannot reach browser storage is reported and the file stays marked unsaved.

## 0.0.1

- First release: canvas editor for `*.view.trig` files, model reading through the Turtle RDF language server, Markdown view embedding and export with SVG diagrams.
