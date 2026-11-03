# Changelog

## Unreleased

- A view file is any `.trig` file with a `view:View`; the `.view.trig` ending is no longer required. New views are saved as `<name>.trig`. A `.trig` file without a view opens in the text editor.
- Browser page sample: flat file names (`data.ttl`, `shapes.ttl`, `cities.ttl`, `prefixes.ttl`, `model.trig`, `instances.trig`), and one SHACL error on purpose (Animal Farm).

## 0.0.2

- The Turtle RDF language server is no longer a hard dependency: Catenary offers to install it at first use, so the package installs on Open VSX editors too.
- Browser page: closing a text tab with unsaved changes asks first; a save that cannot reach browser storage is reported and the file stays marked unsaved.

## 0.0.1

- First release: canvas editor for `*.view.trig` files, model reading through the Turtle RDF language server, Markdown view embedding and export with SVG diagrams.
