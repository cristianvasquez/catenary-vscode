// Check and write Markdown exports with content-hash ownership checks; adapted from catenary-vscode extension/src/node/markdown-export.ts.
// Changed unowned files require overwrite confirmation; obsolete owned files are removed only if unchanged.
/// <reference types="node" />
import { createHash, randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  EXPORT_RESOURCES,
  type ExportProblem,
  type ExportView,
  type LinkTarget,
  type MarkdownDocument,
  type MarkdownExportPlan,
  type UnresolvedEmbed,
  isMarkdownPath,
  localDestination,
  markdownRefs,
  planMarkdownExport,
} from "./markdown"

/** The sources (absolute paths of files and folders), the destination folder, and the documents to leave out (relative to the root). */
export interface MarkdownExportRequest {
  sources: string[]
  destination?: string
  exclude?: string[]
}

/** The check of a Markdown export: the views to render, or why the export cannot run. */
export interface MarkdownExportCheck {
  ok: boolean
  error?: string
  /** The real path of the destination folder. */
  destination?: string
  /** The real path of the source root: the common ancestor folder of the sources. */
  root: string
  /** The documents that the export writes, relative to the root, with `/`, sorted. */
  documents: string[]
  /** Each embedded view once, in the order of its first embed. */
  views: { iri: string; id: string; label: string }[]
  /** Embeds that name no view, with the source file (relative to the source folder) and the line. */
  unresolved: UnresolvedEmbed[]
  /** Links that the export does not change and reports: missing targets, folders, absolute paths. */
  problems: ExportProblem[]
}

/** The result of a Markdown export. Paths are relative to the destination folder. */
export interface MarkdownExportResult {
  ok: boolean
  error?: string
  written: string[]
  /** Files with the same content as the output: not written again. */
  unchanged: string[]
  /** Files of an earlier export that this export does not write, removed. */
  removed: string[]
  /** Files of an earlier export that this export does not write, kept because they changed after that export. */
  kept: string[]
  /**
   * Paths that the export cannot write, with the reason: two outputs at one path, a record file that is not of Catenary, a path that
   * is not allowed or leads out of the destination, a link or a folder at the path. The export wrote nothing, also with `overwrite`.
   */
  conflicts: string[]
  /**
   * Existing files that the export does not own (an export did not write them, or they changed after the last export). Without
   * `overwrite`, the export wrote nothing. With `overwrite`, it wrote them and records them as its files.
   */
  overwritable: string[]
  /** The write that failed; the files in `written` were written before it. */
  failed?: { path: string; error: string }
  unresolved?: UnresolvedEmbed[]
  problems: ExportProblem[]
}

/** The record of the files that the exports to a destination wrote (path relative to the destination → SHA-256 of the content). */
export const OWNERSHIP_FILE = `${EXPORT_RESOURCES}/.catenary-export.json`

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

/** The path of `p` relative to `folder`, with `/`; undefined when `p` is not in the folder (or is the folder). */
function inside(folder: string, p: string): string | undefined {
  const rel = path.relative(folder, p)
  const parent = rel === ".." || rel.startsWith(`..${path.sep}`)
  return rel && !parent && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined
}

/** A relative output path with `/`: no empty, `.` or `..` names, not the ownership record. */
const safePath = (rel: string) =>
  rel !== OWNERSHIP_FILE && !/^[\\/]|^[A-Za-z]:/.test(rel) && !rel.split("/").some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code

/** The real path of `p` when it exists; else the real path of its nearest existing folder, with the rest of `p`. */
async function realPathOf(p: string): Promise<string> {
  const rest: string[] = []
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    try {
      return path.join(await fs.realpath(at), ...rest.reverse())
    } catch (e) {
      if (code(e) !== "ENOENT" && code(e) !== "ENOTDIR") throw e
      if (path.dirname(at) === at) return path.resolve(p)
      rest.push(path.basename(at))
    }
  }
}

/** The Markdown documents of a folder and its subfolders, as absolute paths. No hidden folders (hidden files count), no linked folders. */
async function listDocuments(folder: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(full)
      } else if (
        isMarkdownPath(e.name) &&
        (e.isFile() || (e.isSymbolicLink() && inside(folder, await fs.realpath(full).catch(() => folder)) !== undefined))
      ) {
        out.push(full)
      }
    }
  }
  await walk(folder)
  return out
}

/** The deepest folder that contains each folder (absolute, real paths); undefined when there is none (two drives on Windows). */
function commonFolder(folders: string[]): string | undefined {
  let root = folders[0]
  for (const f of folders.slice(1)) {
    while (root !== f && inside(root, f) === undefined) {
      if (path.dirname(root) === root) return undefined
      root = path.dirname(root)
    }
  }
  return root
}

/** The source root and the documents to export (relative to the root, with `/`), checked; the destination, when the request has one; the plan. */
export interface PreparedExport {
  source: string
  destination?: string
  documents: string[]
  plan: MarkdownExportPlan
}

/**
 * Read the documents of the request and plan their export. The root is the common ancestor folder of the sources: a folder source
 * counts as itself, a file source as its folder. Fails when a source does not exist, or the destination is the root, is inside it, or
 * is not a folder. Without a destination, it does not check one. Paths are absolute.
 */
export async function prepareMarkdownExport(
  request: MarkdownExportRequest,
  views: ReadonlyMap<string, ExportView>,
): Promise<PreparedExport | { error: string }> {
  if (!request.sources.length) return { error: "The export has no source." }
  const sources: { real: string; folder: boolean }[] = []
  for (const source of request.sources) {
    try {
      const real = await fs.realpath(source)
      sources.push({ real, folder: (await fs.stat(real)).isDirectory() })
    } catch {
      return { error: `The source does not exist: ${source}` }
    }
  }
  const root = commonFolder(sources.map((s) => (s.folder ? s.real : path.dirname(s.real))))
  if (root === undefined) return { error: "The sources have no common folder." }
  let dest: string | undefined
  if (request.destination !== undefined) {
    dest = await realPathOf(request.destination)
    if (dest === root || inside(root, dest) !== undefined) {
      return { error: "The destination folder is in the source folder. Choose a folder outside it." }
    }
    const stat = await fs.stat(dest).catch(() => undefined)
    if (stat && !stat.isDirectory()) return { error: `The destination is not a folder: ${request.destination}` }
  }

  const found = new Set<string>()
  for (const s of sources) {
    const files = s.folder ? await listDocuments(s.real) : isMarkdownPath(s.real) ? [s.real] : []
    for (const f of files) found.add(inside(root, f)!)
  }
  const exclude = new Set(request.exclude ?? [])
  const paths = [...found].filter((p) => !exclude.has(p)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const listed = new Set(paths)
  const documents: MarkdownDocument[] = await Promise.all(
    paths.map(async (p) => ({ path: p, text: await fs.readFile(path.join(root, ...p.split("/")), "utf8") })),
  )
  // What each local destination names: read before the plan, which is synchronous.
  const targets = new Map<string, LinkTarget>()
  const key = (doc: string, target: string) => `${doc}\n${target}`
  for (const doc of documents) {
    for (const ref of markdownRefs(doc.text)) {
      const local = localDestination(ref.destination)
      if (!local || local === "absolute" || targets.has(key(doc.path, ref.destination))) continue
      const file = path.join(root, ...doc.path.split("/").slice(0, -1), ...local.path.split("/"))
      targets.set(key(doc.path, ref.destination), await linkTarget(root, file, listed))
    }
  }
  const plan = planMarkdownExport(documents, views, (doc, target) => targets.get(key(doc, target)) ?? { kind: "missing" })
  return { source: root, ...(dest !== undefined ? { destination: dest } : {}), documents: paths, plan }
}

async function linkTarget(root: string, target: string, documents: ReadonlySet<string>): Promise<LinkTarget> {
  let real: string
  try {
    real = await fs.realpath(target)
  } catch {
    return { kind: "missing" }
  }
  const stat = await fs.stat(real)
  if (stat.isDirectory()) return { kind: "unsupported", reason: "The target is a folder." }
  if (!stat.isFile()) return { kind: "unsupported", reason: "The target is not a file." }
  // A path in the folder that a link takes out of it counts as outside.
  const rel = inside(root, target) !== undefined && inside(root, real) !== undefined ? inside(root, target) : undefined
  if (isMarkdownPath(real)) {
    if (rel !== undefined && documents.has(rel)) return { kind: "document" }
    if (rel === undefined) return { kind: "unsupported", reason: "The document is outside the source folder." }
    const hidden = rel
      .split("/")
      .slice(0, -1)
      .some((name) => name.startsWith("."))
    return { kind: "unsupported", reason: hidden ? "The document is in a hidden folder." : "The document is not in the export." }
  }
  return rel === undefined ? { kind: "file", from: real } : { kind: "file", from: real, path: rel }
}

/** The result of a check: the views to render, the unresolved embeds, the reported links. */
export function checkOf(prepared: PreparedExport | { error: string }): MarkdownExportCheck {
  if ("error" in prepared) return { ok: false, error: prepared.error, root: "", documents: [], views: [], unresolved: [], problems: [] }
  const { plan } = prepared
  return {
    ok: !plan.unresolved.length,
    ...(plan.unresolved.length ? { error: unresolvedMessage(plan) } : {}),
    ...(prepared.destination !== undefined ? { destination: prepared.destination } : {}),
    root: prepared.source,
    documents: prepared.documents,
    views: plan.views.map((v) => ({ iri: v.iri, id: v.id, label: v.label })),
    unresolved: plan.unresolved,
    problems: plan.problems,
  }
}

function unresolvedMessage(plan: MarkdownExportPlan): string {
  const n = plan.unresolved.length
  return `${n} view reference${n === 1 ? "" : "s"} name${n === 1 ? "s" : ""} no view. Nothing was exported.`
}

/** The record of an earlier export: {} when there is none; undefined when a file at its path is not a record of Catenary. */
async function readOwnership(dest: string): Promise<Record<string, string> | undefined> {
  const file = path.join(dest, ...OWNERSHIP_FILE.split("/"))
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat) return {}
  if (!stat.isFile()) return undefined
  try {
    const record = JSON.parse(await fs.readFile(file, "utf8"))
    if (record?.generator !== "Catenary" || !record.files || typeof record.files !== "object") return undefined
    return Object.fromEntries(Object.entries(record.files).filter(([, h]) => typeof h === "string")) as Record<string, string>
  } catch {
    return undefined
  }
}

/** Write a file through a temporary file in its folder and a rename. */
async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/**
 * Write the planned export with the SVG of each view (`svgs`: view IRI → SVG text). Stops before the first write when an embed names
 * no view, an SVG or a copied file is missing, or a hard conflict exists (`conflicts`). An existing file that the export does not own
 * (`overwritable`) stops it too, unless `overwrite` is true. A write failure stops the export: the result names the files written before it.
 */
export async function writeMarkdownExport(prepared: PreparedExport, svgs: Record<string, string>, overwrite = false): Promise<MarkdownExportResult> {
  const { plan, destination: dest } = prepared
  const result: MarkdownExportResult = {
    ok: false,
    written: [],
    unchanged: [],
    removed: [],
    kept: [],
    conflicts: [],
    overwritable: [],
    problems: plan.problems,
  }
  if (dest === undefined) return { ...result, error: "The export has no destination folder." }
  if (plan.unresolved.length) return { ...result, error: unresolvedMessage(plan), unresolved: plan.unresolved }

  // All output in memory before the first write. Two outputs at one path (a source file at the path of an SVG): a conflict.
  const output = new Map<string, Buffer>()
  const conflict = (rel: string, why: string) => result.conflicts.push(`${rel}: ${why}`)
  const put = (rel: string, data: Buffer) => {
    if (output.has(rel)) conflict(rel, "two outputs have this path.")
    else output.set(rel, data)
  }
  for (const d of plan.documents) put(d.path, Buffer.from(d.text, "utf8"))
  for (const v of plan.views) {
    const svg = svgs[v.iri]
    if (typeof svg !== "string" || !svg.includes("<svg")) return { ...result, error: `No SVG of the view "${v.label}" (${v.iri}). Nothing was exported.` }
    put(v.path, Buffer.from(svg, "utf8"))
  }
  for (const c of plan.copies) {
    try {
      put(c.path, await fs.readFile(c.from))
    } catch (e) {
      return { ...result, error: `Cannot read ${c.from}: ${(e as Error).message}. Nothing was exported.` }
    }
  }

  // The record's folder must not lead out of the destination either: no read, no write through it.
  const recordInside = inside(dest, await realPathOf(path.join(dest, EXPORT_RESOURCES))) !== undefined
  const record = recordInside ? await readOwnership(dest) : undefined
  if (!recordInside) conflict(OWNERSHIP_FILE, "a folder on the path leads out of the destination folder.")
  else if (!record) conflict(OWNERSHIP_FILE, "the file exists and is not a record of a Catenary export.")
  const owned = record ?? {}
  const pending: [string, Buffer][] = []
  for (const [rel, data] of output) {
    const file = path.join(dest, ...rel.split("/"))
    if (!safePath(rel)) {
      conflict(rel, "the path is not allowed.")
      continue
    }
    // A linked folder on the path must not lead out of the destination.
    const folder = await realPathOf(path.dirname(file))
    if (folder !== dest && inside(dest, folder) === undefined) {
      conflict(rel, "a folder on the path leads out of the destination folder.")
      continue
    }
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat) {
      pending.push([rel, data])
      continue
    }
    if (!stat.isFile()) {
      conflict(rel, stat.isSymbolicLink() ? "a link exists at this path." : "a folder exists at this path.")
      continue
    }
    const now = sha256(await fs.readFile(file))
    if (now === sha256(data)) result.unchanged.push(rel)
    else if (owned[rel] === now) pending.push([rel, data])
    else result.overwritable.push(rel) // The file changed after the last export, or an export did not write it.
  }
  if (result.conflicts.length) {
    const n = result.conflicts.length
    return { ...result, error: `${n} destination file${n === 1 ? "" : "s"} would be overwritten. Nothing was exported.` }
  }
  if (result.overwritable.length && !overwrite) {
    const n = result.overwritable.length
    return { ...result, error: `${n} destination file${n === 1 ? "" : "s"} exist${n === 1 ? "s" : ""} and would be overwritten. Nothing was exported.` }
  }
  for (const rel of result.overwritable) pending.push([rel, output.get(rel)!])

  // Recorded files that this export does not write: removed when unchanged, else kept and no longer recorded.
  const stale: string[] = []
  for (const [rel, hash] of Object.entries(owned)) {
    if (output.has(rel) || !safePath(rel)) continue
    const file = path.join(dest, ...rel.split("/"))
    const stat = await fs.lstat(file).catch(() => undefined)
    const folder = await realPathOf(path.dirname(file))
    if (!stat || (folder !== dest && inside(dest, folder) === undefined)) continue
    if (stat.isFile() && sha256(await fs.readFile(file)) === hash) stale.push(rel)
    else result.kept.push(rel)
  }

  const next: Record<string, string> = Object.fromEntries(Object.entries(owned).filter(([rel]) => output.has(rel) || stale.includes(rel)))
  // An unchanged file stays recorded only when it was: a file with the same content that an export did not write is not claimed.
  for (const rel of result.unchanged) if (rel in owned) next[rel] = sha256(output.get(rel)!)
  const save = () =>
    writeAtomic(
      path.join(dest, ...OWNERSHIP_FILE.split("/")),
      Buffer.from(`${JSON.stringify({ generator: "Catenary", files: sortKeys(next) }, null, 2)}\n`),
    )
  try {
    for (const [rel, data] of pending) {
      try {
        await writeAtomic(path.join(dest, ...rel.split("/")), data)
      } catch (e) {
        result.failed = { path: rel, error: (e as Error).message }
        throw e
      }
      result.written.push(rel)
      next[rel] = sha256(data)
    }
    for (const rel of stale) {
      await fs.rm(path.join(dest, ...rel.split("/")), { force: true })
      result.removed.push(rel)
      delete next[rel]
    }
    await save()
  } catch (e) {
    await save().catch(() => undefined)
    const done = result.written.length
    const at = result.failed?.path ?? OWNERSHIP_FILE
    return { ...result, error: `The export stopped at ${at}: ${(e as Error).message}. ${done} file${done === 1 ? " was" : "s were"} written before it.` }
  }
  return { ...result, ok: true }
}

function sortKeys(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
