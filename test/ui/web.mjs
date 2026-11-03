// The browser page check: serves dist-web/ (pnpm web:build first), opens it in headless Chromium with empty storage, and checks the page
// with a real mouse and keys: the first canvas, turtle-lsp diagnostics, move, undo, redo and save, Insert, TriG and back, a model edit
// that reaches the canvas, persistence after a reload, and the instance view. Each check prints `ok - <name>` or `not ok - <name>`.
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
  await page.goto(url)
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

  // ------------------------------------------------------------------ first canvas
  const first = await until(state, (s) => BOXES.every((b) => s.boxes.includes(b)), 60000)
  await page.screenshot({ path: path.join(out, "web-model.png") })
  check("the first view opens in the canvas with 4 node boxes", first && BOXES.every((b) => first.boxes.includes(b)) && first.boxes.length === 4, JSON.stringify(first))
  check("3 labeled edges", first && EDGES.every((e) => first.edges.includes(e)) && first.edges.length === 3, JSON.stringify(first?.edges))
  const status = await until(() => page.locator("#status").textContent(), (t) => /\d+ warnings/.test(t) && !/ 0 warnings/.test(t))
  check("turtle-lsp diagnostics reach the status bar", /0 errors · [1-9]\d* warnings · \d+ statements/.test(status), status)

  // ------------------------------------------------------------------ move, undo, redo, save
  const name = "bookshop-model.view.trig"
  const card = svgOf().locator(".catenary-card", { hasText: "Author shape" }).first()
  const before = await card.locator(".shape-name").boundingBox()
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 6 })
  await page.mouse.up()
  check("a move makes the canvas tab dirty", await until(() => dirty(name), (d) => d))
  const moved = await card.locator(".shape-name").boundingBox()
  await page.keyboard.press("Control+Z")
  await until(() => dirty(name), (d) => !d)
  // The redraw follows the undo asynchronously (session refresh, then a model update over the port).
  const undone = await until(() => card.locator(".shape-name").boundingBox(), (b) => Math.abs(b.x - before.x) < 2)
  check("Ctrl+Z puts the box back and the tab is clean", !(await dirty(name)) && Math.abs(undone.x - before.x) < 2 && Math.abs(moved.x - before.x) > 20, JSON.stringify({ before, moved, undone }))
  await page.keyboard.press("Control+Y")
  check("Ctrl+Y moves it again", await until(() => dirty(name), (d) => d))
  const sample = (await stored())["views/bookshop-model.view.trig"]
  await page.keyboard.press("Control+S")
  await until(() => dirty(name), (d) => !d)
  const saved = (await stored())["views/bookshop-model.view.trig"]
  check("Ctrl+S writes the view file to browser storage", !(await dirty(name)) && saved !== sample && saved.includes("view:"), `${saved?.length} chars`)

  // ------------------------------------------------------------------ Insert
  await frameOf().locator('.catenary-tools [data-item="insert"]').click()
  const picker = page.locator("dialog#picker")
  await picker.waitFor()
  const offered = await picker.locator("li .label").allTextContents()
  await picker.locator("input[type=text]").fill("Animal Farm")
  await page.keyboard.press("Enter")
  const inserted = await until(state, (s) => s.boxes.length === 5)
  check("Insert offers workspace elements and places the picked one", offered.includes("Link to a file…") && offered.includes("Animal Farm") && inserted?.boxes.includes("Animal Farm"), JSON.stringify({ offered: offered.slice(0, 6), boxes: inserted?.boxes }))

  // ------------------------------------------------------------------ TriG and back
  await frameOf().locator('.catenary-tools [data-item="open-text"]').click()
  await page.locator("#monaco .view-lines").waitFor()
  const text = await page.locator("#monaco .view-lines").textContent()
  check("TriG saves the view and opens it as text", (await page.locator("iframe.canvas-frame").count()) === 0 && text.includes("view:") && !(await tab(name).getAttribute("class")).includes("dirty"))
  await page.locator("#open-canvas").click()
  const back = await until(state, (s) => s.boxes.length === 5)
  check("Open in Canvas shows the view again with the inserted card", back?.boxes.includes("Animal Farm"), JSON.stringify(back))

  // ------------------------------------------------------------------ a model edit reaches the canvas
  await page.locator("#files .file", { hasText: "workspace.shapes.ttl" }).click()
  await page.locator("#monaco .view-lines").waitFor()
  await page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("workspace.shapes.ttl"))
    const match = model.findMatches('"Author shape"', false, false, true, null, false)[0]
    model.pushEditOperations([], [{ range: match.range, text: '"Writer shape"' }], () => null)
  })
  await page.locator("#monaco").click()
  await page.keyboard.press("Control+S")
  await tab(name).click()
  const renamed = await until(state, (s) => s.boxes.includes("Writer shape"))
  check("a saved model edit reaches the open canvas", renamed?.boxes.includes("Writer shape") && !renamed.boxes.includes("Author shape"), JSON.stringify(renamed?.boxes))

  // ------------------------------------------------------------------ closing a dirty text tab
  const shapesName = "workspace.shapes.ttl"
  await tab(shapesName).click()
  await page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("workspace.shapes.ttl"))
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
  const reverted = await page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("workspace.shapes.ttl")).getValue())
  check("discarding a dirty text tab restores the saved model and clears the file's dirty mark", closed && !reverted.includes("Writer shape 2") && reverted.includes("Writer shape") && !(await shapesFile.getAttribute("class")).includes("dirty"))
  await tab(shapesName).locator(".close").click()

  // ------------------------------------------------------------------ reload: the files persist
  await page.reload()
  await page.locator("body[data-ready=true]").waitFor({ timeout: 60000 })
  const reloaded = await until(state, (s) => s.boxes.includes("Animal Farm") && s.boxes.includes("Writer shape"), 30000)
  check("after a reload the saved view and model edits are there", reloaded?.boxes.includes("Animal Farm") && reloaded.boxes.includes("Writer shape"), JSON.stringify(reloaded?.boxes))

  // ------------------------------------------------------------------ the instance view
  await page.locator("#files .file", { hasText: "bookshop.view.trig" }).filter({ hasNotText: "model" }).click()
  const instances = await until(state, (s) => s.boxes.includes("Animal Farm") && s.boxes.includes("George Orwell"), 30000)
  await page.screenshot({ path: path.join(out, "web-bookshop.png") })
  check("the instance view opens in a second canvas tab", (await page.locator("#tabs .tab").count()) === 2 && instances?.boxes.includes("Little corner Bookshop"), JSON.stringify(instances?.boxes))
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
