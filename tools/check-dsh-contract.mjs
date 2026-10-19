// L2 contract test: does the installed Harness still look like what this plugin
// expects? Run: node tools/check-dsh-contract.mjs
//
// This is the check that turns "the API probably still exists" into a fact.
// It never starts a Harness: it imports the packages' lib entry points directly
// and greps the web shell bundle for the module-table seed.
//
// Env: DSH_INSTALL to point at a specific installation (the directory that
// contains node_modules/@deepseek-ai).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const results = []
function ok(name, detail) { results.push({ name, pass: true, detail: detail ?? '' }) }
function fail(name, detail) { results.push({ name, pass: false, detail: detail ?? '' }) }

function candidateInstallRoots() {
  const roots = []
  if (process.env.DSH_INSTALL) roots.push(process.env.DSH_INSTALL)
  const appData = process.env.APPDATA
  if (appData) roots.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  roots.push(path.join(os.homedir(), '.local', 'share', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  roots.push(path.join('/usr', 'local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  return roots
}

function findInstall() {
  for (const root of candidateInstallRoots()) {
    const manifest = path.join(root, 'package.json')
    if (fs.existsSync(manifest)) return root
  }
  return undefined
}

const install = findInstall()
if (install === undefined) {
  console.log('[skip] no dsh installation found; set DSH_INSTALL to check one')
  process.exit(0)
}

const version = JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8')).version
console.log('dsh ' + version + ' at ' + install)

const packages = path.join(install, 'node_modules', '@deepseek-ai')

async function loadPackage(name, entry) {
  const file = path.join(packages, name, entry)
  if (!fs.existsSync(file)) return undefined
  try {
    return await import(pathToFileURL(file).href)
  } catch (error) {
    fail('import ' + name, String(error && error.message))
    return undefined
  }
}

async function expectExports(name, entry, symbols) {
  const module = await loadPackage(name, entry)
  if (module === undefined) {
    fail(name + ' (' + entry + ')', 'missing')
    return
  }
  const absent = symbols.filter((symbol) => typeof module[symbol] !== 'function')
  if (absent.length === 0) ok(name + ' exports ' + symbols.join(', '))
  else fail(name + ' exports', 'absent: ' + absent.join(', '))
}

await expectExports('dsh-tools', 'lib/index.js', ['defineTool'])
await expectExports('dsh-llm', 'lib/index.js', ['createUserMessage'])
await expectExports('dsh-timeout', 'lib/index.js', ['deadline'])
await expectExports('dsh-session-title', 'lib/index.js', ['normalizeSessionTitle'])
await expectExports('dsh-session-title-llm', 'lib/index.js', ['resolveSessionTitleLlmConfig'])

// BlockAssembler / BlockAssembler live on a subpath in dsh-llm
{
  const module = await loadPackage('dsh-llm', 'lib/index.js')
  const assembler = module === undefined ? undefined : module.BlockAssembler
  if (typeof assembler === 'function') ok('dsh-llm exports BlockAssembler')
  else fail('dsh-llm exports BlockAssembler', 'absent (look for a rename)')
}

// Structural facts the operations rely on, verified by reading source text.
const sourceChecks = [
  ['dsh-workspace', 'lib/index.js', 'indexHeader'],
  ['dsh-workspace', 'lib/index.js', 'attachSession'],
  ['dsh-workspace', 'lib/index.js', 'missingSessionPaths'],
  ['dsh-session', 'lib/index.js', 'detachEntered'],
  ['dsh-session', 'lib/index.js', 'snapshotEvents'],
  ['dsh-session-projection-cache', 'lib/index.js', 'session_projcache'],
  ['dsh-session-persistence-jsonl', 'lib/index.js', 'projectKey'],
  ['dsh-session-format', 'lib/index.js', 'parseSessionFormatLogFilename'],
]

for (const [name, entry, needle] of sourceChecks) {
  const file = path.join(packages, name, entry)
  if (!fs.existsSync(file)) {
    fail(name + ' source', 'missing ' + entry)
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(needle)) ok(name + ' carries ' + needle)
  else fail(name + ' carries ' + needle, 'not found in ' + entry)
}

// The web shell's module table must still seed the primitives package: that is
// how require('@deepseek-ai/dsh-client-ui-primitives') resolves in the browser.
{
  const assets = path.join(packages, 'dsh-web-frontend', 'dist', 'assets')
  let found = false
  if (fs.existsSync(assets)) {
    for (const name of fs.readdirSync(assets)) {
      if (!name.endsWith('.js')) continue
      const text = fs.readFileSync(path.join(assets, name), 'utf8')
      if (text.includes('"@deepseek-ai/dsh-client-ui-primitives"')) {
        found = true
        if (!text.includes('MenuItemButton')) fail('client primitives seed', 'seed found but MenuItemButton absent')
        else ok('web shell seeds ui-primitives and still exports MenuItemButton')
        break
      }
    }
  }
  if (!found) fail('web shell seeds ui-primitives', 'seed entry not found in dsh-web-frontend dist')
}

const failed = results.filter((entry) => entry.pass !== true)
for (const entry of results) {
  console.log((entry.pass ? '  ok   ' : '  FAIL ') + entry.name + (entry.detail ? ' :: ' + entry.detail : ''))
}
if (failed.length > 0) {
  console.log('contract: ' + failed.length + ' failed / ' + results.length)
  process.exit(1)
}
console.log('contract: ' + results.length + ' checks, 0 failed (dsh ' + version + ')')
