// The setup of the UI runner (test/ui/run.mjs), from the old repository main: downloads VS Code (cached in .vscode-test/) and the
// turtle-lsp 0.13.0 vsix (cached in .cache/), installs the vsix into .cache/extensions, makes a short temp user data dir and a temp
// copy of test/fixtures/shapes.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron"

const here = path.dirname(fileURLToPath(import.meta.url))
export const root = path.resolve(here, "../..")
const cache = path.join(root, ".cache")
const vsix = path.join(cache, "turtle-lsp-linux-x64-0.13.0.vsix")
export const extensionsDir = path.join(cache, "extensions")
const source = path.join(root, "test/fixtures/shapes")

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status ?? r.signal}`)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === "EPERM"
  }
}

/**
 * Removes the leftovers of killed runs. A VS Code process (`.vscode-test/`) with a `ccvsc-` user data dir is stale when that dir is gone, or when the
 * run that made it (`owner.pid`) is dead; a VS Code from another launcher has no `owner.pid` and stays. A `ccvsc-` or `ccfix-` temp
 * dir is removed when it is older than one hour and no process names it on its command line.
 */
function removeStale() {
  const procs = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().match(/^(\d+) (.*)$/)).filter(Boolean)
  const killed = new Set()
  for (const [, pid, args] of procs) {
    // Only the downloaded VS Code: a shell or a tool can name such a dir on its command line too.
    const dir = args.match(/--user-data-dir=(\S*\/ccvsc-\w{6})(\s|$)/)?.[1]
    if (!dir || !args.split(" ")[0].includes("/.vscode-test/")) continue
    const owner = path.join(dir, "owner.pid")
    const stale = !fs.existsSync(dir) || (fs.existsSync(owner) && !alive(Number(fs.readFileSync(owner, "utf8"))))
    if (!stale) continue
    try {
      process.kill(Number(pid), "SIGKILL")
      killed.add(pid)
    } catch {}
  }
  const hourAgo = Date.now() - 3600_000
  let removed = 0
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!/^cc(vsc|fix)-/.test(name)) continue
    const dir = path.join(os.tmpdir(), name)
    if (fs.statSync(dir).mtimeMs > hourAgo || procs.some(([, pid, args]) => !killed.has(pid) && args.includes(dir))) continue
    fs.rmSync(dir, { recursive: true, force: true })
    removed++
  }
  console.log(`# stale: ${killed.size} processes killed, ${removed} temp dirs removed`)
}

/** VS Code with turtle-lsp installed, a user data dir, a fixture copy; `cleanup()` removes the two temp dirs. */
export async function prepare() {
  removeStale()
  if (!fs.existsSync(vsix)) {
    run("gh", ["release", "download", "v0.13.0", "-R", "abhishekkundu25/turtle-lsp", "-p", path.basename(vsix), "-D", cache])
  }
  const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? "stable")
  // The default CLI args name the default extensions dir; this one replaces it.
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath).filter((a) => !a.startsWith("--extensions-dir"))
  run(cli, [...cliArgs, "--install-extension", vsix, "--extensions-dir", extensionsDir])

  // VS Code puts its IPC socket under the user data dir; the checkout path can
  // make it longer than a socket path may be. Use a short temp dir.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ccvsc-"))
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccfix-"))
  fs.cpSync(source, fixture, { recursive: true })
  fs.mkdirSync(path.join(userData, "User"), { recursive: true })
  fs.writeFileSync(path.join(userData, "owner.pid"), String(process.pid))
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "chat.disableAIFeatures": true }))
  const cleanup = () => {
    fs.rmSync(userData, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
  return { vscodeExecutablePath, userData, fixture, cleanup }
}
