// The browser page check: serves dist-web/ (pnpm web:build first), opens it in headless Chromium with empty storage, and checks the page
// with a real mouse and keys: a turtle/query round trip to the engine, the first canvas, turtle-lsp diagnostics, a move that writes the view
// file, undo and redo, Insert, TriG and back, a model edit that reaches the canvas, persistence after a reload, and the instance view. Each check prints `ok - <name>` or `not ok - <name>`.
// Chromium: CHROMIUM (path), else /usr/bin/chromium. CATENARY_UI_HEADED=1: a visible window. Screenshots: test/ui/out/web-*.png.
import fs from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { chromium } from "playwright-core"

const root = path.resolve(import.meta.dirname, "../..")
const site = path.join(root, "dist-web")
const out = path.join(root, "test/ui/out")
if (!fs.existsSync(path.join(site, "main.js"))) {
  console.error("dist-web/main.js is missing: run pnpm web:build first")
  process.exit(1)
}
fs.mkdirSync(out, { recursive: true })

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".ttf": "font/ttf", ".map": "application/json" }
const server = createServer((req, res) => {
  let file = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname))
  if (!file.startsWith(site)) return res.writeHead(403).end()
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html")
  if (!fs.existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const url = `http://127.0.0.1:${server.address().port}/`

let failed = 0, checks = 0
function check(name, ok, why = "") {
  checks++
  console.log(`${ok ? "ok" : "not ok"} - ${name}${ok || !why ? "" : `: ${why}`}`)
  if (!ok) failed++
}
/** Polls `get()` every 100 ms until `done(value)` or `timeout` ms; returns the last value. */
async function until(get, done, timeout = 15000) {
  const end = Date.now() + timeout
  let value = await get().catch(() => undefined)
  while (Date.now() < end && (value === undefined || !done(value))) {
    await new Promise((r) => setTimeout(r, 100))
    value = await get().catch(() => undefined)
  }
  return value
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: !process.env.CATENARY_UI_HEADED })
const deadline = setTimeout(() => { console.log("not ok - the run ends within 240 s"); process.exit(1) }, 240000)
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(15000)
  page.on("pageerror", (e) => errors.push(e.message))
  const acceptDialog = (d) => d.accept()
  page.on("dialog", acceptDialog)
  await page.goto(`${url}?open=model.trig`)
  await page.locator("body[data-ready=true]").waitFor({ timeout: 60000 })

  const BOXES = ["Shop shape", "Book shape", "Author shape", "Cities"]
  const EDGES = ["ex:city", "ex:stocks", "ex:author"]
  const frameOf = (name) => page.frameLocator(`iframe.canvas-frame:not([hidden])`).first()
  const svgOf = () => frameOf().locator("svg.sprotty-graph:not([id$='_hidden'] svg)")
  const state = () => svgOf().evaluate((el) => ({
    boxes: Array.from(el.querySelectorAll(".catenary-card")).map((g) => g.querySelector(".shape-name, .vs-name, .card-name")?.textContent ?? ""),
    edges: Array.from(el.querySelectorAll(".catenary-edge .edge-label")).map((t) => t.textContent ?? "").filter((t) => t),
  }))
  const tab = (name) => page.locator("#tabs .tab", { has: page.locator(".name", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) })
  const dirty = async (name) => (await tab(name).getAttribute("class")).includes("dirty")
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("catenary-web-files") ?? "{}"))

  // ------------------------------------------------------------------ turtle/query in the engine of the page
  // A second client of the page's engine modules (the module path is an argument: it is a URL of the page, not a module of this repository).
  const rows = await page.evaluate(async (module) => {
    const { LspClient } = await import(module)
    const client = new LspClient(new URL("turtle-lsp/lsp-worker.js", location.href))
    await client.initialize({ processId: null, rootUri: null, capabilities: {} })
    const uri = "file:///probe/a.ttl"
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "turtle", version: 1, text: "<urn:a> <urn:p> \"x\" ." } })
    const answer = await client.request("turtle/query", { query: "SELECT ?s ?o WHERE { ?s <urn:p> ?o }", files: [uri] })
    return answer.results.bindings
  }, "./turtle-lsp/editor-lsp.js")
  check("turtle/query answers in the browser engine", rows.length === 1 && rows[0].s.value === "urn:a" && rows[0].o.value === "x", JSON.stringify(rows))

  // ------------------------------------------------------------------ first canvas
  const first = await until(state, (s) => BOXES.every((b) => s.boxes.includes(b)), 60000)
  await page.screenshot({ path: path.join(out, "web-model.png") })
  check("the first view opens in the canvas with 4 node boxes", first && BOXES.every((b) => first.boxes.includes(b)) && first.boxes.length === 4, JSON.stringify(first))
  check("3 labeled edges", first && EDGES.every((e) => first.edges.includes(e)) && first.edges.length === 3, JSON.stringify(first?.edges))
  const status = await until(() => page.locator("#status").textContent(), (t) => /[1-9]\d* errors · [1-9]\d* warnings/.test(t), 60000)
  check("turtle-lsp diagnostics reach the status bar", /[1-9]\d* errors · [1-9]\d* warnings · \d+ statements/.test(status), status)

  // ------------------------------------------------------------------ move, undo, redo: each writes the view file
  const name = "model.trig"
  // The page stores nothing before the first write: the sample text is the buffer's.
  const buffer = () => page.evaluate((n) => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("/" + n)).getValue(), name)
  const sample = await buffer()
  const card = svgOf().locator(".catenary-card", { hasText: "Author shape" }).first()
  const before = await card.locator(".shape-name").boundingBox()
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 6 })
  await page.mouse.up()
  const saved = await until(async () => (await stored())[name], (t) => t !== sample)
  const moved = await until(() => card.locator(".shape-name").boundingBox(), (b) => Math.abs(b.x - before.x) > 20)
  check("a move changes the view file in the FileStore and its buffer", saved !== sample && saved === (await buffer()) && !(await dirty(name)) && Math.abs(moved.x - before.x) > 20, JSON.stringify({ before, moved, chars: saved?.length }))
  await page.keyboard.press("Control+Z")
  const undoneText = await until(async () => (await stored())[name], (t) => t === sample)
  // The redraw follows the undo asynchronously (didChange, then a model update over the port).
  const undone = await until(() => card.locator(".shape-name").boundingBox(), (b) => Math.abs(b.x - before.x) < 2)
  check("Ctrl+Z puts the box back and the file text back", undoneText === sample && Math.abs(undone.x - before.x) < 2, JSON.stringify({ before, undone }))
  await page.keyboard.press("Control+Y")
  const redone = await until(async () => (await stored())[name], (t) => t === saved)
  check("Ctrl+Y moves it again", redone === saved)
  // Two moves in a row are two undo steps; then the file is back at `saved` for the checks below.
  const other = svgOf().locator(".catenary-card", { hasText: "Book shape" }).first()
  const drag = async (prev) => {
    const at = await until(() => other.locator(".shape-name").boundingBox(), (b) => !prev || b.x !== prev.x)
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
    await page.mouse.down()
    await page.mouse.move(at.x + at.width / 2 + 60, at.y + at.height / 2 + 30, { steps: 6 })
    await page.mouse.up()
    return at
  }
  const at = await drag()
  const once = await until(async () => (await stored())[name], (t) => t !== saved)
  await drag(at)
  const second = await until(async () => (await stored())[name], (t) => t !== once)
  await page.keyboard.press("Control+Z")
  const one = await until(async () => (await stored())[name], (t) => t !== second)
  await page.keyboard.press("Control+Z")
  const none = await until(async () => (await stored())[name], (t) => t === saved)
  check("two moves in a row are two undo steps", once !== saved && second !== once && one === once && none === saved, JSON.stringify([once?.length, second?.length, one?.length, none?.length]))

  // ------------------------------------------------------------------ failed storage and retry
  await page.evaluate(() => { localStorage.setItem = () => { throw new Error('full') } })
  await page.keyboard.press("Control+Z")
  await until(() => dirty(name), (d) => d)
  const warning = page.locator("#toasts .toast.warning", { hasText: "Not stored" })
  await warning.waitFor()
  const notStored = await dirty(name)
  await page.evaluate(() => { delete localStorage.setItem })
  await page.keyboard.press("Control+S")
  const retryClean = await until(() => dirty(name), (d) => !d)
  check("a failed write of the view file warns and stays dirty until a save succeeds", notStored && !retryClean && (await stored())["model.trig"] !== saved)

  // ------------------------------------------------------------------ Insert
  await frameOf().locator('.catenary-tools [data-item="insert"]').click()
  const picker = page.locator("dialog#picker")
  await picker.waitFor()
  const offered = await picker.locator("li .label").allTextContents()
  await picker.locator("input[type=text]").fill("Animal Farm")
  await page.keyboard.press("Enter")
  const inserted = await until(state, (s) => s.boxes.length === 5)
  check("Insert offers workspace elements and places the picked one", offered.includes("Link to a file…") && offered.includes("Animal Farm") && inserted?.boxes.includes("Animal Farm"), JSON.stringify({ offered: offered.slice(0, 6), boxes: inserted?.boxes }))
  // The sample view already places the other view (Bookshop); remove it before linking it again.
  const references = () => svgOf().locator(".catenary-view-reference").count()
  const existing = svgOf().locator(".catenary-view-reference", { hasText: /^Bookshop$/ })
  // The redraws of the insert can land after the click: Delete waits until the reference is the only selected element.
  const selected = () => svgOf().locator("[data-svg-metadata-type^=node].selected").evaluateAll((els) => els.map((e) => e.getAttribute("class")))
  for (let i = 0; i < 10; i++) {
    await existing.click()
    const now = await until(selected, (l) => l.length === 1 && l[0].includes("view-reference"), 1000)
    if (now?.length === 1 && now[0].includes("view-reference")) break
  }
  await page.keyboard.press("Delete")
  await existing.waitFor({ state: "detached" })
  const referencesBefore = await references()
  await frameOf().locator('.catenary-tools [data-item="insert"]').click()
  await picker.waitFor()
  await picker.locator("li", { hasText: "Link to a view…" }).click()
  const viewPicker = await until(() => picker.locator("input[type=text]").getAttribute("placeholder"), (t) => t === "Link to a view")
  await picker.locator("li").first().click()
  const referencesAfter = await until(references, (n) => n === referencesBefore + 1)
  check("a click on Link to a view opens the view picker at once", viewPicker === "Link to a view" && referencesAfter === referencesBefore + 1, `${viewPicker}; ${referencesBefore} -> ${referencesAfter}`)

  // ------------------------------------------------------------------ TriG and back
  await frameOf().locator('.catenary-tools [data-item="open-text"]').click()
  await page.locator("#monaco .view-lines").waitFor()
  const text = await page.locator("#monaco .view-lines").textContent()
  check("TriG saves the view and opens it as text", (await page.locator("iframe.canvas-frame").count()) === 0 && text.includes("view:") && !(await tab(name).getAttribute("class")).includes("dirty"))
  await page.locator("#open-canvas").click()
  const back = await until(state, (s) => s.boxes.length === 5)
  check("Open in Canvas shows the view again with the inserted card", back?.boxes.includes("Animal Farm"), JSON.stringify(back))

  // ------------------------------------------------------------------ a model edit reaches the canvas
  await page.locator("#files .file", { hasText: "shapes.ttl" }).click()
  await page.locator("#monaco .view-lines").waitFor()
  await page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("shapes.ttl"))
    const match = model.findMatches('"Author shape"', false, false, true, null, false)[0]
    model.pushEditOperations([], [{ range: match.range, text: '"Writer shape"' }], () => null)
  })
  await page.locator("#monaco").click()
  await page.keyboard.press("Control+S")
  await tab(name).click()
  const renamed = await until(state, (s) => s.boxes.includes("Writer shape"))
  check("a saved model edit reaches the open canvas", renamed?.boxes.includes("Writer shape") && !renamed.boxes.includes("Author shape"), JSON.stringify(renamed?.boxes))

  // ------------------------------------------------------------------ closing a dirty text tab
  const shapesName = "shapes.ttl"
  await tab(shapesName).click()
  await page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("shapes.ttl"))
    const match = model.findMatches('"Writer shape"', false, false, true, null, false)[0]
    model.pushEditOperations([], [{ range: match.range, text: '"Writer shape 2"' }], () => null)
  })
  page.off("dialog", acceptDialog)
  page.once("dialog", (d) => d.dismiss())
  await tab(shapesName).locator(".close").click()
  page.on("dialog", acceptDialog)
  check("canceling a dirty text tab close keeps the tab and its changes", await tab(shapesName).count() === 1 && await dirty(shapesName))

  await tab(shapesName).locator(".close").click()
  const closed = await tab(shapesName).count() === 0
  const shapesFile = page.locator("#files .file", { hasText: shapesName })
  await shapesFile.click()
  const reverted = await page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("shapes.ttl")).getValue())
  check("discarding a dirty text tab restores the saved model and clears the file's dirty mark", closed && !reverted.includes("Writer shape 2") && reverted.includes("Writer shape") && !(await shapesFile.getAttribute("class")).includes("dirty"))
  await tab(shapesName).locator(".close").click()

  // ------------------------------------------------------------------ reload: the files persist
  await page.reload()
  await page.locator("body[data-ready=true]").waitFor({ timeout: 60000 })
  const reloaded = await until(state, (s) => s.boxes.includes("Animal Farm") && s.boxes.includes("Writer shape"), 30000)
  check("after a reload the saved view and model edits are there", reloaded?.boxes.includes("Animal Farm") && reloaded.boxes.includes("Writer shape"), JSON.stringify(reloaded?.boxes))

  // ------------------------------------------------------------------ the instance view
  await page.locator("#files .file", { hasText: "instances.trig" }).click()
  const instances = await until(state, (s) => s.boxes.includes("Animal Farm") && s.boxes.includes("George Orwell"), 30000)
  await page.screenshot({ path: path.join(out, "web-bookshop.png") })
  check("the instance view opens in a second canvas tab", (await page.locator("#tabs .tab").count()) === 2 && instances?.boxes.includes("Little corner Bookshop"), JSON.stringify(instances?.boxes))
  await svgOf().locator(".catenary-card", { hasText: "Animal Farm" }).first().locator(".badge text").click()
  const problemTab = await until(() => tab("data.ttl").count(), (n) => n === 1)
  check("a click on the violation badge opens the problem", problemTab === 1 && (await tab("data.ttl").getAttribute("class")).includes("active"), `${problemTab} data.ttl tabs`)
  check("no page errors", errors.length === 0, errors.join(" | "))
} catch (e) {
  check("the run completes", false, e.message)
} finally {
  clearTimeout(deadline)
  await browser.close()
  server.close()
}
console.log(`# ${checks} checks, ${failed} failed`)
process.exit(failed ? 1 : 0)
