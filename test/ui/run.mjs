// The UI check, from the old repository main (test/ui/run.mjs): launches the downloaded VS Code (test/vscode/setup.mjs) with Playwright
// `_electron.launch` on a temp copy of test/fixtures/shapes (the fixture files are not modified), opens views in the canvas with Quick
// Open and checks them with a real mouse and keys. model.trig: the 4 node boxes and the 3 labeled edges.
// instances.trig: selection, move and save, select all, pan, marquee, zoom, edge selection, Delete and Ctrl+Z, the palette,
// Collect, and the halo expand of a hidden neighbour. Each check prints `ok - <name>` or `not ok - <name>`. Screenshots: test/ui/out/.
// Needs: `pnpm build` first (dist/extension.js), the network on the first run (VS Code, the turtle-lsp vsix through `gh`). Headless by
// default with Chromium's `--ozone-platform=headless`. CATENARY_UI_HEADED=1: a visible window on the current display.
// `--section <name>` (model, bookshop): only that section runs, after the shared setup.
import fs from "node:fs"
import path from "node:path"
import { Parser } from "n3"
import { _electron } from "playwright-core"
import { extensionsDir, prepare, root } from "../vscode/setup.mjs"

const VIEW = "https://cristianvasquez.github.io/catenary/vocab/view#"
/** The statements of a TriG text (n3). */
const trig = (text) => new Parser({ format: "application/trig" }).parse(text)

const BOXES = ["Shop shape", "Book shape", "Author shape", "Cities"]
const EDGES = ["ex:city", "ex:stocks", "ex:author"]
const out = path.join(root, "test/ui/out")
/** The webview of the active view editor: a hidden view editor keeps its webview (retainContextWhenHidden). */
const WEBVIEW = "iframe.webview.ready >> visible=true"

if (!fs.existsSync(path.join(root, "dist/extension.js"))) {
  console.error("dist/extension.js is missing: run pnpm build first")
  process.exit(1)
}

/** Polls `get()` every 100 ms until `done(value)` or `timeout` ms; returns the last value. A `get()` that blocks (an evaluate on a
 *  webview frame that VS Code replaced) is cut at the deadline; the result is then the last value that `get()` returned. */
async function until(get, done, timeout = 10000) {
  const end = Date.now() + timeout
  const bounded = () => {
    let timer
    const left = new Promise((r) => { timer = setTimeout(() => r(undefined), Math.max(end - Date.now(), 100)) })
    return Promise.race([Promise.resolve(get()).catch(() => undefined), left]).finally(() => clearTimeout(timer))
  }
  let value = await bounded()
  let last = value
  while (Date.now() < end && (value === undefined || !done(value))) {
    await new Promise((r) => setTimeout(r, 100))
    value = await bounded()
    if (value !== undefined) last = value
  }
  return value ?? last
}

// The deadline of the whole run: a gesture that never completes stops the run instead of blocking it.
const RUN_DEADLINE_MS = Number(process.env.CATENARY_UI_DEADLINE_MS ?? 300000)

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
let checks = 0
function check(name, ok, why = "") {
  checks++
  console.log(`${ok ? "ok" : "not ok"} - ${name}${ok || !why ? "" : `: ${why}`}`)
  if (!ok) failed++
}

// The sections: blocks of checks; a check depends on the earlier gestures of its section only.
const SECTIONS = ["model", "bookshop"]
const only = process.argv.includes("--section") ? process.argv[process.argv.indexOf("--section") + 1] : undefined
if (only !== undefined && !SECTIONS.includes(only)) {
  console.error(`unknown section ${only}; sections: ${SECTIONS.join(", ")}`)
  process.exit(2)
}
const ran = []
async function section(name, body) {
  if (only !== undefined && only !== name) return
  ran.push(name)
  await body()
}

const fixtureDir = path.join(root, "test/fixtures/shapes")
const fixtureFiles = () => fs.readdirSync(fixtureDir, { recursive: true }).sort().map((f) => {
  const file = path.join(fixtureDir, f)
  return fs.statSync(file).isFile() ? `${f}\n${fs.readFileSync(file, "utf8")}` : f
}).join("\n")
const fixtureBefore = fixtureFiles()
const { vscodeExecutablePath, userData, fixture, cleanup } = await prepare()
const violationTriple = '\n<urn:name:Animal%20Farm> <http://www.example.org/publicationYear> 1946 .\n'
// The sample data has a datatype error on purpose (the published example); the test starts from valid data with one maxCount violation.
const validData = fs.readFileSync(path.join(fixtureDir, 'data.ttl'), 'utf8').replace('"nineteen forty-five"', '1945')
fs.writeFileSync(path.join(fixture, 'data.ttl'), validData + violationTriple)
// No secondary side bar: the canvas gets the width. A fixed theme: the screenshot is compared with Catenary's (a dark theme).
fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
  "chat.disableAIFeatures": true, "workbench.secondarySideBar.defaultVisibility": "hidden", "workbench.colorTheme": "Default Dark Modern",
  // The save prompt of a dirty editor in the workbench DOM, not a native dialog.
  "window.dialogStyle": "custom", "turtle.diagnostics.workspace": true,
}))

const app = await _electron.launch({
  executablePath: vscodeExecutablePath,
  args: [
    fixture,
    `--extensionDevelopmentPath=${root}`,
    "--extensions-dir",
    extensionsDir,
    `--user-data-dir=${userData}`,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    ...(process.env.CATENARY_UI_HEADED ? [] : ["--ozone-platform=headless"]),
  ],
  timeout: 60000,
})

const deadline = setTimeout(() => {
  check(`the run ends within ${RUN_DEADLINE_MS / 1000} s (CATENARY_UI_DEADLINE_MS); stopped after ${checks} checks`, false)
  console.log(`# sections: ${ran.join(", ")}; ${checks} checks, ${failed} failed`)
  app.process().kill("SIGKILL")
  cleanup()
  process.exit(1)
}, RUN_DEADLINE_MS)

try {
  const page = await app.firstWindow()
  // An action or locator wait that never resolves fails in 15 s, not at the run deadline.
  page.setDefaultTimeout(15000)
  // The headless screen is small; a fixed window size gives the same geometry in both modes.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.locator(".monaco-workbench").waitFor({ timeout: 60000 })
  fs.mkdirSync(out, { recursive: true })

  /** Opens a view file in the canvas (Quick Open: a file named on the command line opens as text); resolves with its SVG locator. */
  async function open(file, names) {
    await page.keyboard.press("Control+P")
    await page.locator(".quick-input-widget input").waitFor()
    await page.keyboard.type(file)
    // The row of this file name: fuzzy matching also lists the other view files, the recently opened first.
    const row = page.locator(".quick-input-list .monaco-list-row", { has: page.locator(".label-name", { hasText: new RegExp(`^${file.replace(/\./g, "\\.")}$`) }) }).first()
    await row.waitFor()
    await row.click()
    const frame = page.frameLocator(WEBVIEW).frameLocator("#active-frame")
    // Not the hidden svg of sprotty (`<baseDiv>_hidden`: it renders a model before the layout).
    const svg = frame.locator("svg.sprotty-graph:not([id$='_hidden'] svg)")
    await svg.waitFor({ timeout: 60000 })
    // The first model comes after the turtle-lsp answer; the first draw fits the view. Wait until the DOM stops changing.
    let last = ""
    await until(() => state(svg), (s) => {
      const now = JSON.stringify(s)
      const stable = now === last && names.every((b) => s.boxes.includes(b))
      last = now
      return stable
    }, 60000)
    // The status toast of the GLSP integration ("Model loading in progress") closes after the first model.
    await page.locator(".notifications-toasts .notification-toast").waitFor({ state: "detached", timeout: 15000 }).catch(() => {})
    return { frame, svg }
  }

  /** What the checks read of a canvas. */
  const state = (svg) =>
    svg.evaluate((el) => ({
      boxes: Array.from(el.querySelectorAll(".catenary-card")).map((g) => g.querySelector(".shape-name, .vs-name, .card-name")?.textContent ?? ""),
      // Labeled edges only: the arrow of a note has no label. Hidden edges are not drawn.
      edges: Array.from(el.querySelectorAll(".catenary-edge .edge-label")).map((t) => t.textContent ?? "").filter((t) => t),
      collections: el.querySelectorAll(".catenary-collection").length,
      selected: Array.from(el.querySelectorAll(".selected")).filter((g) => g.id).map((g) => g.id),
      viewport: el.querySelector("g")?.getAttribute("transform") ?? "",
    }))

  async function openData() {
    await page.keyboard.press('Control+P')
    await page.locator('.quick-input-widget input').fill('data.ttl')
    await page.locator('.quick-input-list .monaco-list-row', { has: page.locator('.label-name', { hasText: /^data\.ttl$/ }) }).first().click()
    await pause(500)
  }
  await openData()
  await pause(3000)
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+S')
  await pause(3000)
  await page.keyboard.press('Control+W')

  // ------------------------------------------------------------------ the model view (read path)
  await section("model", async () => {
    const { svg } = await open("model.trig", BOXES)
    const s = await state(svg)
    await page.screenshot({ path: path.join(out, "bookshop-model.png") })
    const missingBoxes = BOXES.filter((b) => !s.boxes.includes(b))
    const missingEdges = EDGES.filter((e) => !s.edges.includes(e))
    console.log(`# boxes: ${JSON.stringify(s.boxes)}`)
    console.log(`# edges: ${JSON.stringify(s.edges)}`)
    check(`${BOXES.length} node boxes`, s.boxes.length === BOXES.length && !missingBoxes.length, `missing ${JSON.stringify(missingBoxes)}`)
    check(`${EDGES.length} labeled edges`, s.edges.length === EDGES.length && !missingEdges.length, `missing ${JSON.stringify(missingEdges)}`)
    {
      const name = svg.locator('.catenary-card', { hasText: 'Book shape' }).first().locator('.shape-name')
      await name.dblclick()
      await pause(500)
      const inputs = await svg.locator('input.catenary-name-input, input.catenary-embedded-input').count()
      check('double click on a shape name opens no rename input (a model edit)', inputs === 0, `${inputs} inputs`)
      await page.keyboard.press('Escape')
    }
    {
      // Hide the existing relation first so its row can add a new visible edge.
      // The label takes no pointer events: click the middle of the line.
      const line = svg.locator('.catenary-edge', { hasText: 'ex:author' }).first().locator('.line').first()
      const mid = await line.evaluate((l) => {
        const p = l.getPointAtLength(l.getTotalLength() / 2), m = l.getScreenCTM()
        return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
      })
      const o = await page.frameLocator(WEBVIEW).locator("#active-frame").boundingBox()
      await page.mouse.click(o.x + mid.x, o.y + mid.y)
      await page.keyboard.press('Delete')
      await until(() => state(svg), s => !s.edges.includes('ex:author'))
      const row = svg.locator('.catenary-card', { hasText: 'Book shape' }).first().locator('.shape-row').filter({ hasText: 'ex:author' }).first()
      await row.hover()
      await row.locator('.row-out').click()
      const added = await until(() => state(svg), s => s.edges.length === EDGES.length)
      check('the property row arrow adds one edge labeled with its path', added.edges.length === EDGES.length && added.edges.includes('ex:author'), JSON.stringify(added.edges))
      await page.keyboard.press('Control+Z')
      const undone = await until(() => state(svg), s => s.edges.length === EDGES.length - 1)
      check('Ctrl+Z removes the edge added by the property row arrow', undone.edges.length === EDGES.length - 1 && !undone.edges.includes('ex:author'), JSON.stringify(undone.edges))
      await page.keyboard.press('Control+Z')
      await until(() => state(svg), s => s.edges.length === EDGES.length)
    }
    const toolbar = page.frameLocator('iframe.webview.ready').frameLocator('#active-frame').locator('.catenary-tools')
    await toolbar.locator('[data-item="group"]').focus()
    await page.keyboard.press('Alt+p')
    const shortcutsVisible = await toolbar.locator('[data-item="group"] .key-shortcut').isVisible() && await toolbar.locator('[data-item="note"] .key-shortcut').isVisible()
    await page.keyboard.press('Alt+p')
    check('the palette shows Insert, Group, Note, Layout, TriG last and keyboard hints', await svg.locator('..').count() > 0 && shortcutsVisible && JSON.stringify(await toolbar.locator('.catenary-tool > span:not(.codicon):not(.key-shortcut)').allTextContents()) === JSON.stringify(['Insert', 'Group', 'Note', 'Layout', 'TriG']))
    await toolbar.screenshot({ path: path.join(out, 'bookshop-toolbar.png') })
    {
      const fileTabs = page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: /^model\.trig$/ }) })
      const tabIndex = await fileTabs.evaluate(el => Array.from(el.parentElement.children).indexOf(el))
      const cards = [...(await state(svg)).boxes].sort()
      const name = await svg.locator('.catenary-card', { hasText: 'Author shape' }).first().locator('.shape-name').boundingBox()
      await page.mouse.move(name.x + name.width / 2, name.y + name.height / 2)
      await page.mouse.down()
      await page.mouse.move(name.x + name.width / 2 + 20, name.y + name.height / 2 + 10, { steps: 5 })
      await page.mouse.up()
      await until(() => fileTabs.getAttribute('class'), c => c.includes('dirty'))
      const onDisk = fs.readFileSync(path.join(fixture, 'model.trig'), 'utf8')
      await toolbar.locator('[data-item="open-text"]').click()
      await page.locator('.editor-instance .monaco-editor').waitFor()
      check('TriG on a dirty canvas opens the view as text with no dialog', await page.getByRole('dialog').count() === 0)
      check('TriG opens the view as text with one tab in the same position', await fileTabs.count() === 1 && await fileTabs.evaluate(el => Array.from(el.parentElement.children).indexOf(el)) === tabIndex && await page.locator(WEBVIEW).count() === 0)
      // The new text tab gets its dirty class after the editor shows: wait for it.
      const textTab = await until(() => fileTabs.getAttribute('class'), c => c?.includes('dirty'), 5000)
      const unchanged = fs.readFileSync(path.join(fixture, 'model.trig'), 'utf8') === onDisk
      check('the text tab keeps the unsaved canvas change (dirty, file on disk unchanged)', textTab?.includes('dirty') === true && unchanged, JSON.stringify({ textTab, unchanged }))
      await page.locator('.editor-instance .monaco-editor').click()
      await page.keyboard.press('Control+f')
      await page.keyboard.type('A simple Bookstore model')
      await page.keyboard.press('Escape')
      await page.keyboard.type('Unsaved TriG note')
      await page.getByRole('button', { name: 'Catenary: Open in Canvas', exact: true }).click()
      const prompt = page.locator('.monaco-dialog-box')
      await Promise.race([svg.waitFor({ timeout: 60000 }), prompt.waitFor({ timeout: 60000 })])
      const asked = await prompt.count() ? await prompt.textContent() : ''
      check('Open in Canvas on dirty text opens the canvas with no dialog', !asked, asked)
      await svg.waitFor({ timeout: 60000 })
      const restored = await until(() => state(svg), s => s.boxes.length === cards.length)
      check('Open in Canvas returns to one tab in the same position with the same cards', await fileTabs.count() === 1 && await fileTabs.evaluate(el => Array.from(el.parentElement.children).indexOf(el)) === tabIndex && JSON.stringify([...restored.boxes].sort()) === JSON.stringify(cards), JSON.stringify(restored.boxes))
      const note = svg.locator('.catenary-note', { hasText: 'Unsaved TriG note' })
      check('Canvas immediately shows the unsaved TriG note edit', await note.count() === 1)
      // Make a canvas edit so Save must write the store back to disk, not just leave the text save untouched.
      const moved = await svg.locator('.catenary-card', { hasText: 'Author shape' }).first().locator('.shape-name').boundingBox()
      await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2)
      await page.mouse.down()
      await page.mouse.move(moved.x + moved.width / 2 + 10, moved.y + moved.height / 2 + 10, { steps: 5 })
      await page.mouse.up()
      await page.keyboard.press('Control+S')
      await until(() => fileTabs.getAttribute('class'), c => !c.includes('dirty'))
      const saved = trig(fs.readFileSync(path.join(fixture, 'model.trig'), 'utf8'))
      check('a subsequent canvas save preserves the TriG note edit', saved.some(q => q.predicate.value === VIEW + 'text' && q.object.value.includes('Unsaved TriG note')))
    }
    await page.frameLocator('iframe.webview.ready').frameLocator('#active-frame').locator('[data-item="insert"]').click()
    await page.locator('.quick-input-widget input').waitFor()
    check('palette Insert… opens the workspace quick pick', await page.locator('.quick-input-widget input').getAttribute('placeholder') === 'Insert elements from the workspace')
    const choices = await page.locator('.quick-input-list .monaco-list-row').allTextContents()
    check('Insert leaves out the placed Shop shape', choices.length > 0 && !choices.some(text => text.includes(BOXES[0])), JSON.stringify(choices))
    await page.keyboard.press('Escape')
    const author = svg.locator('.catenary-card', { hasText: 'Author shape' }).first()
    await author.locator('.shape-name').click()
    await page.keyboard.press('Delete')
    await until(() => state(svg), s => !s.boxes.includes('Author shape'))
    await page.getByRole('button', { name: 'Catenary: Insert Element…' }).click()
    await page.locator('.quick-input-widget input').fill('Author shape')
    await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Author shape' }).first().click()
    await page.keyboard.press('Enter')
    const inserted = await until(() => state(svg), s => s.boxes.includes('Author shape'))
    check('insert command with a typed filter places Author shape', inserted.boxes.includes('Author shape'))
    await svg.click({ position: { x: 20, y: 20 } })
    await page.keyboard.press('Control+Z')
    const undone = await until(() => state(svg), s => !s.boxes.includes('Author shape'))
    check('Ctrl+Z removes the inserted Author shape', !undone.boxes.includes('Author shape'))
    await page.keyboard.press('Control+Z')
    await page.keyboard.press('Control+S')
    // A reference opens the target in a second canvas tab; close it before continuing.
    await svg.locator('.catenary-view-reference').first().dblclick()
    const tabs = await until(() => page.locator('.tabs-container .tab .label-name').allTextContents(), names => names.includes('instances.trig'))
    const target = page.frameLocator(WEBVIEW).frameLocator('#active-frame').locator('svg.sprotty-graph:not([id$="_hidden"] svg)')
    const opened = await until(() => state(target), s => s.boxes.includes('Animal Farm'))
    check('double click on a view reference opens Bookshop in a second canvas tab', tabs.includes('model.trig') && tabs.includes('instances.trig') && opened.boxes.includes('Animal Farm'), JSON.stringify(tabs))
    await page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: /^instances\.trig$/ }) }).click()
    await page.keyboard.press('Control+W')
    await until(() => state(svg), s => s.boxes.includes('Book shape'))
    // One canvas at a time: the frame locators find one webview.
    await page.keyboard.press("Control+W")
    await until(() => page.locator('iframe.webview').count(), n => n === 0)
  })

  // ------------------------------------------------------------------ the instance view: gestures and edits
  await section("bookshop", async () => {
    const viewFile = path.join(fixture, "instances.trig")
    const { frame, svg } = await open("instances.trig", ["Animal Farm", "George Orwell", "Tangamandapio"])
    /** The card of an instance by its name. */
    const card = (name) => svg.locator(".catenary-card", { has: frame.locator(".card-name", { hasText: name }) }).first()
    /** A point of a card in page coordinates: its name (a press there selects or moves the card). */
    const cardPoint = async (name) => {
      const b = await card(name).locator(".card-name").boundingBox()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    /** The page point of the canvas frame origin: frame point = page point - origin. */
    const origin = () => page.frameLocator(WEBVIEW).locator("#active-frame").boundingBox()
    /** No element of the view at the page point `p` (a press there is on empty canvas). */
    const isFree = async (p) => {
      const o = await origin()
      return svg.evaluate((el, [x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return !!hit && el.contains(hit) && !hit.closest(".catenary-card, .catenary-edge, .catenary-note, .catenary-group, .catenary-view-reference, .catenary-collection, .catenary-halo")
      }, [p.x - o.x, p.y - o.y])
    }
    /** An empty point of the canvas, in page coordinates. */
    const emptyPoint = async () => {
      const box = await svg.boundingBox()
      for (let y = box.y + 40; y < box.y + box.height - 20; y += 30) {
        for (let x = box.x + 20; x < box.x + box.width - 20; x += 30) if (await isFree({ x, y })) return { x, y }
      }
      throw new Error("no empty point on the canvas")
    }
    /** Pans the canvas with a drag on empty canvas until the card `name` is at the center: its halo buttons are on screen. */
    const reveal = async (name) => {
      const box = await svg.boundingBox(), c = await card(name).boundingBox()
      const dx = box.x + box.width / 2 - (c.x + c.width / 2), dy = box.y + box.height / 2 - (c.y + c.height / 2)
      const p = await emptyPoint()
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + (dx * i) / 10, p.y + (dy * i) / 10)
      await page.mouse.up()
      await pause(300)
    }
    const selectedNames = () => svg.evaluate((el) => Array.from(el.querySelectorAll(".catenary-card.selected")).map((g) => g.querySelector(".card-name")?.textContent ?? ""))
    const s0 = await state(svg)
    console.log(`# cards: ${JSON.stringify(s0.boxes)}`)
    console.log(`# edges: ${JSON.stringify(s0.edges)}`)

    const badge = card('Animal Farm').locator('.badge')
    const badgeText = await until(() => badge.locator('text').allTextContents(), texts => texts.includes('1'), 60000)
    check('violating Animal Farm shows a badge with 1', badgeText.join('') === '1', JSON.stringify(badgeText))
    check('badge title shows the turtle-lsp message', (await badge.locator('title').textContent()).includes('expected at most 1 value(s)'))
    await openData()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(validData)
    await page.keyboard.press('Control+S')
    await pause(1500)
    await page.keyboard.press('Control+W')
    const badgeCount = await until(() => badge.count(), n => n === 0, 60000)
    check('fixing data in the editor and saving removes the badge', badgeCount === 0)

    // Palette: the View section (Group, Note).
    {
      const items = await frame.locator(".tool-palette .tool-button[data-item]").evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.dataset.item))
      check("the palette shows Group and Note", items.includes("group") && items.includes("note"), JSON.stringify(items))
    }

    // Double click on the note opens its editor; Ctrl+Enter commits; after Ctrl+S the view file holds the text.
    {
      const before = fs.readFileSync(viewFile, "utf8")
      const note = svg.locator(".catenary-note").first()
      const b = await note.boundingBox()
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
      const field = frame.locator(".catenary-note-popover textarea")
      await field.waitFor({ timeout: 5000 })
      await field.press("Control+End")
      await page.keyboard.type(" Edited in place.")
      await page.keyboard.press("Control+Enter")
      await field.waitFor({ state: "detached", timeout: 5000 }).catch(() => {})
      const drawn = await until(() => note.textContent(), (t) => t.includes("Edited in place."), 5000)
      await page.keyboard.press("Control+S")
      const after = await until(() => fs.readFileSync(viewFile, "utf8"), (t) => t !== before, 10000)
      const texts = trig(after).filter((q) => q.predicate.value === VIEW + "text").map((q) => q.object.value)
      check("double click on the note edits its text in place", drawn.includes("Edited in place."), drawn.slice(0, 80))
      check("after Ctrl+S the view file holds the note text", texts.some((t) => t.includes("Edited in place.")), JSON.stringify(texts))
    }


    // Click selects a card; Shift+click adds another one.
    {
      const p = await cardPoint("Animal Farm")
      await page.mouse.click(p.x, p.y)
      const one = await until(selectedNames, (s) => s.length === 1)
      check("click selects a card", one.length === 1 && one[0] === "Animal Farm", JSON.stringify(one))
      const q = await cardPoint("George Orwell")
      await page.keyboard.down("Shift")
      await page.mouse.click(q.x, q.y)
      await page.keyboard.up("Shift")
      const two = await until(selectedNames, (s) => s.length === 2)
      check("shift+click adds to the selection", two.length === 2 && two.includes("Animal Farm") && two.includes("George Orwell"), JSON.stringify(two))
    }

    // Drag of a card moves it; after Ctrl+S the view file has the new position.
    {
      const id = await card("Nineteen Eighty-Four").getAttribute("id")
      const placement = decodeURIComponent(id.replace(/^.*?_n-/, "").replace(/_([0-9a-f]{2})/g, "%$1"))
      /** The view:x of the placement in a view file (TriG). */
      const xOf = (text) => {
        const x = trig(text).find((q) => q.subject.value === placement && q.predicate.value === VIEW + "x")
        return x ? Number(x.object.value) : undefined
      }
      const before = fs.readFileSync(viewFile, "utf8")
      const p = await cardPoint("Nineteen Eighty-Four")
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + 15 * i, p.y + 5 * i)
      await page.mouse.up()
      const moved = await until(() => cardPoint("Nineteen Eighty-Four"), (q) => q.x - p.x > 100, 5000)
      const dirty = await until(() => page.locator(".tab.active.dirty").count(), (n) => n > 0, 5000)
      await page.keyboard.press("Control+S")
      const after = await until(() => fs.readFileSync(viewFile, "utf8"), (t) => t !== before, 10000)
      const [x0, x1] = [xOf(before), xOf(after)]
      console.log(`# ${placement}: x ${x0} -> ${x1}`)
      check("drag of a card moves it", moved.x - p.x > 100, `moved ${moved.x - p.x} px`)
      check("the move marks the view editor dirty", dirty > 0)
      check("after Ctrl+S the view file holds the new position", after !== before && x0 !== undefined && x1 !== undefined && x1 > x0 + 50, `x ${x0} -> ${x1}`)
      const clean = await until(() => page.locator(".tab.active.dirty").count(), (n) => n === 0, 5000)
      check("after Ctrl+S the view editor is not dirty", clean === 0)
    }

    // Ctrl+A selects all elements and selects no text.
    {
      const p = await emptyPoint()
      await page.mouse.click(p.x, p.y)
      await page.keyboard.press("Control+A")
      const all = await until(() => state(svg), (s) => s.selected.length >= s0.boxes.length)
      const text = await svg.evaluate(() => String(document.getSelection()))
      check("Ctrl+A selects all", all.selected.length >= s0.boxes.length, `${all.selected.length} selected`)
      check("Ctrl+A leaves no text selection", text === "", JSON.stringify(text.slice(0, 40)))
      await page.mouse.click(p.x, p.y)
      await until(selectedNames, (s) => s.length === 0)
    }

    // Click on an edge selects it; Delete removes it from the view; Ctrl+Z gives it back.
    {
      const edges = (await state(svg)).edges.length
      // The middle of the line of the "ex:city" edge, in page coordinates.
      const edge = svg.locator(".catenary-edge", { has: frame.locator(".edge-label", { hasText: "ex:city" }) }).first()
      const mid = await edge.locator(".line").first().evaluate((line) => {
        const p = line.getPointAtLength(line.getTotalLength() / 2), m = line.getScreenCTM()
        return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
      })
      const o = await origin()
      await page.mouse.click(o.x + mid.x, o.y + mid.y)
      const selected = await until(() => edge.getAttribute("class"), (c) => /\bselected\b/.test(c ?? ""), 3000)
      check("click on an edge selects it", /\bselected\b/.test(selected ?? ""), selected ?? "")
      await page.keyboard.press("Delete")
      const removed = await until(() => state(svg), (s) => s.edges.length === edges - 1, 5000)
      check("Delete on a selected edge removes it from the view", removed.edges.length === edges - 1 && !removed.edges.includes("ex:city"), JSON.stringify(removed.edges))
      await page.keyboard.press("Control+Z")
      const back = await until(() => state(svg), (s) => s.edges.length === edges, 5000)
      check("Ctrl+Z gives the edge back", back.edges.length === edges && back.edges.includes("ex:city"), JSON.stringify(back.edges))

      await page.mouse.click(o.x + mid.x, o.y + mid.y)
      await until(() => edge.getAttribute("class"), c => /\bselected\b/.test(c ?? ""), 3000)
      await page.keyboard.press("Delete")
      await until(() => state(svg), s => !s.edges.includes("ex:city"), 5000)
      const cards = (await state(svg)).boxes.length
      await reveal("Tangamandapio")
      const p = await cardPoint("Tangamandapio")
      await page.mouse.click(p.x, p.y)
      const button = svg.locator('.catenary-halo .halo-action[data-action="expandIn"]')
      await button.waitFor({ timeout: 5000 })
      const b = await button.boundingBox()
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
      const item = frame.locator('.catenary-popup-picker .item').filter({ hasText: '(in the view)' }).first()
      await item.waitFor({ timeout: 5000 })
      const i = await item.boundingBox()
      await page.mouse.click(i.x + 20, i.y + i.height / 2)
      const restored = await until(() => state(svg), s => s.edges.includes("ex:city"), 5000)
      check("halo expand restores a deleted relation without adding cards", restored.edges.length === edges && restored.edges.includes("ex:city") && restored.boxes.length === cards, `${restored.edges.length} edges, ${cards} -> ${restored.boxes.length} cards`)
    }

    // A drag on empty canvas pans; Shift+drag draws a marquee and selects the cards in it; the wheel zooms.
    {
      const before = (await state(svg)).viewport
      const p = await emptyPoint()
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(p.x + 10 * i, p.y + 6 * i)
      await page.mouse.up()
      const after = await until(() => state(svg), (s) => s.viewport !== before, 3000)
      check("drag on empty canvas pans", after.viewport !== before, `${before} -> ${after.viewport}`)

      // The marquee starts on empty canvas above and left of the card, and ends below and right of it.
      const box = await card("Animal Farm").boundingBox()
      let start = { x: box.x - 15, y: box.y - 15 }
      for (let d = 15; d < 200 && !(await isFree(start)); d += 15) start = { x: box.x - d, y: box.y - d }
      const end = { x: box.x + box.width + 15, y: box.y + box.height + 15 }
      await page.keyboard.down("Shift")
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      let marquee = 0
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(start.x + ((end.x - start.x) * i) / 10, start.y + ((end.y - start.y) * i) / 10)
        marquee = Math.max(marquee, await svg.evaluate((el) => el.querySelectorAll(".marquee").length))
      }
      await page.mouse.up()
      await page.keyboard.up("Shift")
      const inside = await until(selectedNames, (s) => s.includes("Animal Farm"), 3000)
      check("shift+drag draws a marquee", marquee > 0 && inside.includes("Animal Farm"), `marquee ${marquee}, selected ${JSON.stringify(inside)}`)
      await page.mouse.click(p.x, p.y)

      const zoomBefore = (await state(svg)).viewport
      const c = await emptyPoint()
      await page.mouse.move(c.x, c.y)
      await page.mouse.wheel(0, -400)
      const zoomed = await until(() => state(svg), (s) => s.viewport !== zoomBefore, 3000)
      const scale = (t) => Number(/scale\(([\d.e-]+)/.exec(t)?.[1])
      check("wheel zooms", scale(zoomed.viewport) > scale(zoomBefore), `${zoomBefore} -> ${zoomed.viewport}`)
      // Back to the zoom before: the canvas draws only the elements in the viewport.
      await page.mouse.wheel(0, 400)
      await until(() => state(svg), (s) => scale(s.viewport) <= scale(zoomBefore) * 1.01, 3000)
      await page.screenshot({ path: path.join(out, "bookshop-gestures.png") })
    }

    // The halo of a card expands a hidden neighbour: Tangamandapio has one incoming relation from an instance that the view does not show.
    {
      const cards = (await state(svg)).boxes.length
      await reveal("Tangamandapio")
      const p = await cardPoint("Tangamandapio")
      await page.mouse.click(p.x, p.y)
      const button = svg.locator('.catenary-halo .halo-action[data-action="expandIn"]')
      await button.waitFor({ timeout: 5000 })
      const b = await button.boundingBox()
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
      const picker = frame.locator(".catenary-popup-picker .item").first()
      await picker.waitFor({ timeout: 5000 })
      const label = await picker.textContent()
      const i = await picker.boundingBox()
      await page.mouse.click(i.x + 20, i.y + i.height / 2)
      const after = await until(() => state(svg), (s) => s.boxes.length === cards + 1, 5000)
      console.log(`# expanded: ${label}`)
      check("the halo of a card expands hidden neighbours", after.boxes.length === cards + 1, `${cards} -> ${after.boxes.length} cards`)
    }

    // Collect of two selected cards gives one collection (the halo of the selection).
    {
      const before = await state(svg)
      const p = await cardPoint("Animal Farm"), q = await cardPoint("Nineteen Eighty-Four")
      await page.mouse.click(p.x, p.y)
      await page.keyboard.down("Shift")
      await page.mouse.click(q.x, q.y)
      await page.keyboard.up("Shift")
      await until(selectedNames, (s) => s.length === 2)
      const button = svg.locator('.catenary-halo .halo-action[data-action="collect"]')
      await button.waitFor({ timeout: 5000 })
      const b = await button.boundingBox()
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
      const after = await until(() => state(svg), (s) => s.collections === before.collections + 1, 5000)
      await page.screenshot({ path: path.join(out, "bookshop-collect.png") })
      check("Collect of two selected cards gives one collection", after.collections === before.collections + 1 && after.boxes.length === before.boxes.length - 2,
        `collections ${before.collections} -> ${after.collections}, cards ${before.boxes.length} -> ${after.boxes.length}`)
    }

    // "+ member" of the collection: an input with the instances of the workspace; Enter adds the typed one as a member row.
    // A row button (×) removes the member from the view.
    {
      const collection = svg.locator(".catenary-collection").first()
      const rows = () => collection.locator(".member-row[data-member]").count()
      const n = await rows()
      const add = await collection.locator(".member-add").boundingBox()
      await page.mouse.click(add.x + 10, add.y + add.height / 2)
      const input = frame.locator("input.catenary-embedded-input")
      await input.waitFor({ timeout: 5000 })
      const options = await until(() => frame.locator("#catenary-inline-options option").evaluateAll((os) => os.map((o) => o.value)), (v) => v.length > 0, 5000)
      check("+ member offers the instances of the workspace that are not members", options.includes("George Orwell") && !options.includes("Animal Farm"), JSON.stringify(options))
      await input.fill("George Orwell")
      await input.press("Enter")
      const added = await until(rows, (c) => c === n + 1, 5000)
      check("+ member adds the chosen instance as a member row", added === n + 1, `${n} -> ${added} rows`)
      // Enter opens the next "+ member": Escape closes it.
      await frame.locator("input.catenary-embedded-input").press("Escape").catch(() => {})
      const cards = (await state(svg)).boxes.length
      const row = collection.locator(".member-row[data-member]").last()
      const r = await row.boundingBox()
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
      const x = await row.locator(".member-remove").boundingBox()
      await page.mouse.click(x.x + x.width / 2, x.y + x.height / 2)
      const removed = await until(rows, (c) => c === n, 5000)
      const s = await state(svg)
      check("the × of a member row removes the member from the view", removed === n && s.boxes.length === cards, `${n + 1} -> ${removed} rows, cards ${cards} -> ${s.boxes.length}`)
    }

    // Apply Layout (palette Layout…, Layered) moves cards; Ctrl+Z puts them back. The canvas draws only the cards in the viewport, and the
    // layout fits the view: the cards drawn before and after are compared by id. Last check of the view: the viewport stays fitted.
    {
      const places = () => svg.evaluate((el) => Object.fromEntries(Array.from(el.querySelectorAll(".catenary-card")).map((g) => [g.id, g.getAttribute("transform")])))
      const differ = (a, b) => Object.keys(a).filter((id) => id in b && a[id] !== b[id]).length
      const before = await places()
      await frame.locator('[data-item="apply-layout"]').click()
      const item = frame.locator(".catenary-popup-picker .item", { hasText: "Layered" }).first()
      await item.waitFor({ timeout: 5000 })
      const i = await item.boundingBox()
      await page.mouse.click(i.x + 20, i.y + i.height / 2)
      const laid = await until(places, (t) => differ(t, before) > 0, 10000)
      check("Apply Layout moves at least one card", differ(laid, before) > 0, JSON.stringify(laid))
      const p = await emptyPoint()
      await page.mouse.click(p.x, p.y)
      await page.keyboard.press("Control+Z")
      const back = await until(places, (t) => differ(t, laid) > 0 && differ(t, before) === 0, 10000)
      const common = Object.keys(back).filter((id) => id in before).length
      check("Ctrl+Z after Apply Layout puts the cards back", common > 0 && differ(back, before) === 0, `${common} cards compared, ${differ(back, before)} differ`)
    }

    // Palette Group, a click on empty canvas: a new group. Double click on its label types a new label in place (a view element).
    {
      const groups = () => svg.locator(".catenary-group").count()
      const n = await groups()
      await frame.locator('.tool-palette .tool-button[data-item="group"]').click()
      const p = await emptyPoint()
      await page.mouse.click(p.x, p.y)
      await until(groups, (c) => c === n + 1, 5000)
      const label = svg.locator(".catenary-group .group-label").last()
      const b = await label.boundingBox()
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
      const input = frame.locator("input.catenary-name-input")
      await input.waitFor({ timeout: 5000 })
      await input.fill("Shelf")
      await input.press("Enter")
      const text = await until(() => svg.locator(".catenary-group .group-label").allTextContents(), (t) => t.includes("Shelf"), 5000)
      check("double click on a group label renames the group in place", text.includes("Shelf"), JSON.stringify(text))
    }

    // Close without saving and open again at once: the view is the file (the unsaved expand and Collect are gone), not dirty.
    {
      await page.keyboard.press("Control+W")
      const dontSave = page.locator(".monaco-dialog-box .monaco-button", { hasText: "Don't Save" })
      await dontSave.waitFor({ timeout: 10000 })
      await dontSave.click()
      await page.locator("iframe.webview").waitFor({ state: "detached", timeout: 10000 })
      const again = await open("instances.trig", ["Animal Farm", "Nineteen Eighty-Four"])
      const s = await state(again.svg)
      const dirty = await page.locator(".tab.active.dirty").count()
      check("closed without saving, the view opens again as its file", s.collections === 0 && !s.boxes.includes("Cities") && s.boxes.length === s0.boxes.length && dirty === 0,
        `collections ${s.collections}, cards ${JSON.stringify(s.boxes)}, dirty ${dirty}`)
    }

    // Copy, cut and paste (kata tc43): Bookshop model and Bookshop open in two editors; the locators find the active one.
    {
      const modelView = path.join(fixture, "model.trig"), dataFile = path.join(fixture, "data.ttl")
      const status = () => frame.locator(".sprotty-status-message").textContent().catch(() => "")
      /** Clicks a free point of the active canvas (focus and paste point), then presses `key`. */
      const press = async (key) => {
        const p = await emptyPoint()
        await page.mouse.click(p.x, p.y)
        await page.keyboard.press(key)
      }
      const selectShape = async (name) => {
        await svg.locator(".catenary-card .shape-name", { hasText: new RegExp(`^${name}$`) }).first().click()
        await until(() => state(svg), (s) => s.selected.length > 0, 3000)
      }
      /** Shows the open view editor of `file` (a click on its tab) and waits until its canvas is the one visible webview and draws `name`. */
      const show = async (file, name) => {
        await page.locator(".tabs-container .tab", { has: page.locator(".label-name", { hasText: new RegExp(`^${file.replace(/\./g, "\\.")}$`) }) }).first().click()
        await until(() => page.locator(WEBVIEW).count(), (n) => n === 1, 10000)
        await until(() => state(svg), (s) => s.boxes.includes(name), 10000)
      }
      /** The view file places `iri`. */
      const places = (file, iri) => {
        return trig(fs.readFileSync(file, "utf8")).some((q) => q.predicate.value === VIEW + "element" && q.object.value === iri)
      }

      await open("model.trig", BOXES)
      await selectShape("Author shape")
      await page.keyboard.press("Control+C")
      await pause(500)
      await show("instances.trig", "Animal Farm")
      await press("Control+V")
      const copied = await until(() => state(svg), (s) => s.boxes.includes("Author shape"), 10000)
      check("Ctrl+C of Author shape in Bookshop model and Ctrl+V in Bookshop places it", copied.boxes.includes("Author shape"), JSON.stringify(copied.boxes))

      await show("model.trig", "Book shape")
      await selectShape("Book shape")
      await page.keyboard.press("Control+X")
      await pause(500)
      await show("instances.trig", "Animal Farm")
      await press("Control+V")
      const moved = await until(() => state(svg), (s) => s.boxes.includes("Book shape"), 10000)
      check("Ctrl+X in Bookshop model and Ctrl+V in Bookshop places Book shape", moved.boxes.includes("Book shape"), JSON.stringify(moved.boxes))
      await show("model.trig", "Shop shape")
      const source = await until(() => state(svg), (s) => !s.boxes.includes("Book shape"), 5000)
      const dirty = await page.locator(".tab.active.dirty").count()
      await page.keyboard.press("Control+S")
      const saved = await until(() => places(modelView, "urn:name:Book%20shape"), (p) => !p, 10000)
      check("after the move and Ctrl+S the source view file no longer holds Book shape", !source.boxes.includes("Book shape") && dirty > 0 && !saved,
        `source ${JSON.stringify(source.boxes)}, dirty ${dirty}, in file ${saved}`)

      await show("instances.trig", "Animal Farm")
      const modelBefore = fs.readFileSync(dataFile, "utf8")
      const boxesBefore = (await state(svg)).boxes.length
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), '<urn:name:Bookshop%20shape> a <http://www.w3.org/ns/shacl#NodeShape> .\n<urn:name:Terry%20Pratchett> a <urn:example:bookshop:Author> .\n')
      await press("Control+V")
      // urn:name:Bookshop%20shape is drawn as "Shop shape".
      const existing = await until(() => state(svg), (s) => s.boxes.includes("Shop shape"), 10000)
      const placedText = await until(status, (t) => /Placed/.test(t ?? ""), 5000)
      check("paste of one known and one unknown subject places one card", existing.boxes.includes("Shop shape") && existing.boxes.length === boxesBefore + 1 && /Placed 1\./.test(placedText), `${JSON.stringify(existing.boxes)}, status ${placedText}`)
      check("paste reports the unknown subject and asks for it to be added to a model file first", /Subjects not in the workspace: 1\. They must be added to a model file first\./.test(placedText), placedText)
      check("paste leaves the model file text unchanged", fs.readFileSync(dataFile, "utf8") === modelBefore)
      await press("Control+Z")
      const undone = await until(() => state(svg), (s) => !s.boxes.includes("Shop shape"), 5000)
      check("Ctrl+Z removes the placement of the pasted subject", !undone.boxes.includes("Shop shape"), JSON.stringify(undone.boxes))
    }

    // Halo view attributes: a color edit and its undo do not change the model.
    {
      await open("model.trig", ["Shop shape"])
      const target = svg.locator(".catenary-card", { has: frame.locator(".shape-name", { hasText: "Shop shape" }) }).first()
      await target.locator(".shape-name").click()
      const color = () => target.evaluate((el) => el.style.getPropertyValue("--c"))
      const before = await color()
      await svg.locator('.catenary-halo .halo-action[data-action="menu"]').click()
      const picker = frame.locator(".catenary-popup-picker")
      await picker.locator(`.swatch[aria-label="${before === "#d65a68" ? "green" : "red"}"]`).click()
      const after = await until(color, (value) => value !== before)
      check("halo color swatch changes the card color", after !== before, `${before} -> ${after}`)
      check("choosing a halo color closes the picker", await picker.count() === 0)
      await target.locator(".shape-name").click()
      await page.keyboard.press("Control+Z")
      const undone = await until(color, (value) => value === before)
      check("Ctrl+Z restores the card color", undone === before, `${before} -> ${undone}`)
      await svg.locator('.catenary-halo .halo-action[data-action="menu"]').click()
      check("swatches keep keyboard navigation in the filter", await picker.locator(".swatch").evaluateAll((buttons) => buttons.every((button) => button.tabIndex === -1)))
      await picker.locator("input").press("ArrowDown")
      await picker.locator("input").press("Enter")
      const keyboardColor = await until(color, (value) => value === "transparent")
      check("arrow key and Enter choose a halo swatch", keyboardColor === "transparent" && await picker.count() === 0, keyboardColor)
      await target.locator(".shape-name").click()
      await page.keyboard.press("Control+Z")
      await until(color, (value) => value === before)
      await svg.locator('.catenary-halo .halo-action[data-action="menu"]').click()
      await picker.locator("input").press("Escape")
      check("Escape closes the halo picker", await picker.count() === 0)
    }

    // Insert a view reference without dragging, then undo that reference.
    {
      // The fixture already places Bookshop; remove it before inserting it again.
      const existing = svg.locator('.catenary-view-reference', { hasText: /^bookshop$/i })
      await existing.click()
      await page.keyboard.press('Delete')
      await existing.waitFor({ state: 'detached' })
      await frame.locator('[data-item="insert"]').click()
      // A single click on the link row opens the view picker: no confirm.
      await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Link to a view…' }).click()
      const input = page.locator('.quick-input-widget input')
      await until(() => input.getAttribute('placeholder'), (text) => text === 'Link to a view')
      await input.fill('bookshop')
      const references = () => svg.locator('.catenary-view-reference').count()
      const before = await references()
      await page.locator('.quick-input-list .monaco-list-row', { has: page.locator('.label-name', { hasText: /^bookshop$/i }) }).click()
      const linked = await until(references, (n) => n === before + 1, 10000)
      check('Insert → Link to a view… → bookshop adds a view reference in bookshop-model', linked === before + 1, `${before} -> ${linked}`)
      const p = await emptyPoint()
      await page.mouse.click(p.x, p.y)
      await page.keyboard.press('Control+Z')
      const undone = await until(references, (n) => n === before, 10000)
      check('Ctrl+Z removes the view reference added by Insert', linked === before + 1 && undone === before, `${linked} -> ${undone}`)
      await page.keyboard.press('Control+Z')
      await existing.waitFor()
    }

    // Restore the violation in the temp model, then navigate from its halo menu.
    {
      await openData()
      await page.keyboard.press('Control+End')
      await page.keyboard.insertText(violationTriple)
      await page.keyboard.press('Control+S')
      await page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: /^instances\.trig$/ }) }).first().click()
      await page.keyboard.press('Control+W')
      await page.locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).click()
      // Quick Open (Control+P in open()) does not show while the dialog has focus: wait until the dialog and the closed tab are gone.
      await page.locator('.monaco-dialog-box').waitFor({ state: 'detached' })
      await page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: /^instances\.trig$/ }) }).waitFor({ state: 'detached' })
      await open('instances.trig', ['Animal Farm'])
      await until(() => badge.locator('text').allTextContents(), texts => texts.includes('1'), 60000)
      const bounds = await svg.boundingBox()
      const beforeZoom = (await state(svg)).viewport
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.wheel(0, 400)
      await until(() => state(svg), s => s.viewport !== beforeZoom)
      await card('Animal Farm').locator('.card-name').click()
      await svg.locator('.catenary-halo .halo-action[data-action="menu"]').click()
      await frame.locator('.catenary-popup-picker .item', { hasText: /^Show the problem$/ }).click()
      const activeData = page.locator('.tab.active .label-name', { hasText: /^data\.ttl$/ })
      const opened = await until(() => activeData.isVisible(), visible => visible)
      check('Show the problem opens data.ttl in the active editor', opened)
      const problems = await until(() => page.locator('.markers-panel').isVisible(), visible => visible)
      check('Show the problem opens the Problems panel', problems)
      await page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: /^instances\.trig$/ }) }).first().click()
      await activeData.waitFor({ state: 'hidden' })
      // Zoom in again at the badge: at the zoom above, an edge of the Bookshop card lies over the badge.
      const zoomed = (await state(svg)).viewport
      const b = await badge.locator('text').boundingBox()
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.wheel(0, -400)
      await until(() => state(svg), s => s.viewport !== zoomed)
      await badge.locator('text').click()
      const badgeOpened = await until(() => activeData.isVisible(), visible => visible)
      check('a click on the violation badge opens data.ttl in the active editor', badgeOpened)
    }

    // Book shape aggregates the publicationYear violation of Animal Farm.
    {
      await page.keyboard.press('Control+J')
      const tab = page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: /^model\.trig$/ }) }).first()
      await tab.click()
      const dirty = await tab.evaluate(el => el.classList.contains('dirty'))
      await page.keyboard.press('Control+W')
      if (dirty) await page.locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).click()
      await tab.waitFor({ state: 'detached' })
      // The copy/cut checks saved the removal of Book shape; restore this temp view.
      fs.copyFileSync(path.join(fixtureDir, 'model.trig'), path.join(fixture, 'model.trig'))
      await pause(3000)
      await open('model.trig', ['Book shape'])
      const target = svg.locator('.catenary-card', { has: frame.locator('.shape-name', { hasText: /^Book shape$/ }) }).first()
      await until(() => target.locator('.badge text').allTextContents(), texts => texts.includes('1'), 60000)
      await target.locator('.shape-name').click()
      await svg.locator('.catenary-halo .halo-action[data-action="menu"]').click()
      await frame.locator('.catenary-popup-picker .item', { hasText: /^Show the problem$/ }).click()
      const opened = await until(() => page.locator('.tab.active .label-name', { hasText: /^data\.ttl$/ }).isVisible(), visible => visible)
      check('Show the problem on Book shape opens data.ttl in the active editor', opened)
    }
  })

  // The checks write the temp copy only.
  check("the fixture files are not modified", fixtureFiles() === fixtureBefore)
} catch (err) {
  console.error(err)
  failed++
} finally {
  clearTimeout(deadline)
  await app.close().catch(() => {})
  cleanup()
}
console.log(`# sections: ${ran.join(", ")}; ${checks} checks, ${failed} failed`)
if (failed) process.exitCode = 1
