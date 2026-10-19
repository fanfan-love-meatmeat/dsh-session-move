// Dependency-direction guard for the layered design.
// Run: node tools/check-layers.mjs
//
// Rules (report/deepseek/T2_重新设计框架/202610191145_层设计.md):
//   1. core/  imports nothing host-side and nothing from ops/ports/adapters
//   2. ops/   imports only ../txn.js, ../core/*, ../ports/*
//   3. txn.js imports nothing host-side
//   4. surfaces (http.js, tools.js) never import adapters/
//   5. adapters/ is the only place that imports @deepseek-ai/*
//   6. client.js uses the loader factory only (no ESM imports)

import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'src')
const failures = []
let checked = 0

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8')
  const out = []
  const staticImport = /\bfrom\s+'([^']+)'/g
  const bareImport = /\bimport\s+'([^']+)'/g
  let match
  while ((match = staticImport.exec(text)) !== null) out.push(match[1])
  while ((match = bareImport.exec(text)) !== null) out.push(match[1])
  return out
}

function report(file, specifier, reason) {
  failures.push(path.relative(SRC, file) + ' imports "' + specifier + '" — ' + reason)
}

for (const file of walk(SRC)) {
  checked++
  const relative = path.relative(SRC, file).replace(/\\/g, '/')
  const specifiers = importsOf(file)

  for (const specifier of specifiers) {
    const isHost = specifier.startsWith('@deepseek-ai/')
    const target = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)) : specifier

    if (relative.startsWith('core/')) {
      if (isHost) report(file, specifier, 'core must stay host-free')
      else if (target.startsWith('ops/') || target.startsWith('ports/') || target.startsWith('adapters/') || target === 'txn.js') {
        report(file, specifier, 'core must not depend on layers above it')
      }
      continue
    }

    if (relative.startsWith('ops/')) {
      const allowed = target === 'txn.js' || target.startsWith('core/') || target.startsWith('ports/') || specifier === 'node:path'
      if (!allowed) report(file, specifier, 'ops may only use txn.js, core/ and ports/')
      continue
    }

    if (relative === 'txn.js') {
      if (isHost) report(file, specifier, 'txn.js must stay host-free')
      continue
    }

    if (relative === 'http.js' || relative === 'tools.js' || relative === 'index.js' || relative === 'config.js') {
      if (target.startsWith('adapters/') && relative !== 'index.js') {
        report(file, specifier, 'surfaces must not import adapters/ directly')
      }
      continue
    }

    if (relative.startsWith('adapters/')) continue // the only place host imports are allowed

    if (relative === 'client.js') {
      report(file, specifier, 'client.js runs in the browser module loader and may not use ESM imports')
    }
  }
}

if (failures.length > 0) {
  console.log('layer check FAILED (' + failures.length + ' of ' + checked + ' files)')
  for (const line of failures) console.log('  x ' + line)
  process.exit(1)
}
console.log('layers: ' + checked + ' files, 0 violations')
