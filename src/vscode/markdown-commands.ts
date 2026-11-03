// Wire Insert View and Export Markdown to VS Code pickers and temporary SVG rendering; file planning is in node/markdown*.ts.
import * as vscode from "vscode"
import { type ExportView, viewEmbed } from "../node/markdown"
import { type MarkdownExportResult, checkOf, prepareMarkdownExport, writeMarkdownExport } from "../node/markdown-export"
import { type View, readView } from "../node/markdown-view"

/** The answers of the pickers of the next `catenary.exportMarkdown`, for the integration tests. */
export interface ExportAnswer {
  /** The documents to export, relative to the source root. */
  documents: string[]
  /** The destination folder. */
  destination: string
  /** The answer to the overwrite question. */
  overwrite?: boolean
}

/** A view file of the workspace and its view. */
export interface ViewEntry {
  file: vscode.Uri
  view: View
}

/** The `*.trig` files of the workspace folders that read as views, by path; the text of an open editor counts. */
async function workspaceViews(): Promise<ViewEntry[]> {
  const files = (await vscode.workspace.findFiles("**/*.trig")).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const out: ViewEntry[] = []
  for (const file of files) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString())
    try {
      const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(file))
      out.push({ file, view: readView(text) })
    } catch {
      // Not a view: not listed.
    }
  }
  return out
}

const labelOf = (view: View) => view.name || view.iri
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The counts of a written export, and the first links that it did not change. */
function exportReport(result: MarkdownExportResult, documents: number, views: number, destination: string): string {
  const counts = [`${result.written.length} written`, `${result.unchanged.length} unchanged`, `${result.removed.length} removed`]
  if (result.kept.length) counts.push(`${result.kept.length} kept`)
  const problems = result.problems.length
    ? ` ${plural(result.problems.length, "link")} not changed: ${result.problems
        .slice(0, 3)
        .map((p) => `${p.file}:${p.line} ${p.target}: ${p.message}`)
        .join("; ")}${result.problems.length > 3 ? "; …" : ""}`
    : ""
  return `Catenary: exported ${plural(documents, "document")} and ${plural(views, "view")} to ${destination} (files: ${counts.join(", ")}).${problems}`
}

/** Inserts the embed of a view of the workspace, from a QuickPick, at each selection of the active Markdown editor. */
export async function insertView(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== "markdown") {
    void vscode.window.showInformationMessage("Catenary: open a Markdown document first.")
    return
  }
  const entries = await workspaceViews()
  if (!entries.length) {
    void vscode.window.showInformationMessage("Catenary: the workspace has no view file (*.trig with a view:View).")
    return
  }
  const pick = await vscode.window.showQuickPick(
    entries.map((entry) => ({ label: labelOf(entry.view), description: entry.view.iri, detail: vscode.workspace.asRelativePath(entry.file), entry })),
    { title: "Catenary: view to insert", matchOnDescription: true },
  )
  if (!pick) return
  const embed = viewEmbed(labelOf(pick.entry.view), pick.entry.view.iri)
  await editor.edit((edit) => {
    for (const selection of editor.selections) edit.replace(selection, embed)
  })
}

/**
 * Exports the Markdown documents of `uris` (the Explorer selection), or of `uri`, or of the workspace folders: the documents to
 * export and the destination folder from pickers, then one SVG per embedded view. Returns the result, or undefined when canceled.
 */
export async function exportMarkdown(
  uri: vscode.Uri | undefined,
  uris: vscode.Uri[] | undefined,
  answer: ExportAnswer | undefined,
  svgOf: (entry: ViewEntry) => Promise<string>,
): Promise<MarkdownExportResult | undefined> {
  const picked = uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : vscode.window.activeTextEditor?.document.languageId === "markdown" ? [vscode.window.activeTextEditor.document.uri] : (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)
  const sources = picked.filter((u) => u.scheme === "file").map((u) => u.fsPath)
  const entries = new Map<string, ViewEntry>()
  for (const entry of await workspaceViews()) if (!entries.has(entry.view.iri)) entries.set(entry.view.iri, entry)
  const views = new Map<string, ExportView>([...entries].map(([iri, e]) => [iri, { id: e.file.toString(), label: labelOf(e.view) }]))
  const fail = (error: string) => {
    void vscode.window.showErrorMessage(`Catenary: ${error}`)
    return undefined
  }

  const listed = await prepareMarkdownExport({ sources }, views)
  if ("error" in listed) return fail(listed.error)
  if (!listed.documents.length) {
    void vscode.window.showInformationMessage("Catenary: no Markdown document to export.")
    return undefined
  }
  let documents = answer?.documents
  if (!documents) {
    const picks = await vscode.window.showQuickPick(
      listed.documents.map((d) => ({ label: d, picked: true })),
      { canPickMany: true, title: "Catenary: documents to export" },
    )
    if (!picks?.length) return undefined
    documents = picks.map((p) => p.label)
  }
  let destination = answer?.destination
  if (destination === undefined) {
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Export here",
      title: "Catenary: destination folder",
    })
    if (!folder?.length) return undefined
    destination = folder[0].fsPath
  }
  const chosen = new Set(documents)
  const exclude = listed.documents.filter((d) => !chosen.has(d))
  const prepared = await prepareMarkdownExport({ sources, destination, exclude }, views)
  const check = checkOf(prepared)
  if ("error" in prepared || !check.ok) {
    const unresolved = check.unresolved.slice(0, 3).map((u) => `${u.file}:${u.line} ${u.iri}`)
    return fail(`${check.error}${unresolved.length ? ` ${unresolved.join("; ")}` : ""}`)
  }

  const svgs: Record<string, string> = {}
  for (const view of prepared.plan.views) {
    try {
      svgs[view.iri] = await svgOf(entries.get(view.iri)!)
    } catch (err) {
      return fail(`no SVG of the view ${view.label}: ${err instanceof Error ? err.message : String(err)}. Nothing was exported.`)
    }
  }
  let result = await writeMarkdownExport(prepared, svgs)
  if (!result.ok && result.overwritable.length && !result.conflicts.length) {
    const overwrite =
      answer?.overwrite ??
      (await vscode.window.showWarningMessage(
        `Catenary: ${result.error} Overwrite them?`,
        { modal: true, detail: result.overwritable.join("\n") },
        "Overwrite",
      )) === "Overwrite"
    if (overwrite) result = await writeMarkdownExport(prepared, svgs, true)
  }
  if (result.ok) void vscode.window.showInformationMessage(exportReport(result, prepared.documents.length, prepared.plan.views.length, destination))
  else fail(result.error ?? "the export failed.")
  return result
}
