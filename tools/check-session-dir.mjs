// Read-only inspector for one session directory.
//
//   node --import ./tools/stub-loader.mjs tools/check-session-dir.mjs <session-dir>
//
// Prints every recognized log generation and the header of the authoritative
// (highest) one. Writes nothing — safe to point at ~/.dsh/sessions.

import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const { sessionLogFiles, readSessionHeader, scanZstdFrames } = await import('../src/index.js')

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node --import ./tools/stub-loader.mjs tools/check-session-dir.mjs <session-dir>')
  process.exit(2)
}
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`not a directory: ${target}`)
  process.exit(2)
}

const logs = sessionLogFiles(target)
console.log(`directory: ${path.resolve(target)}`)
if (logs.length === 0) {
  console.log('generations: none — no session[.vN].jsonl[.zstd] file found')
  process.exit(1)
}

for (const log of logs) {
  const bytes = fs.readFileSync(log.file)
  const frames = log.compressed ? scanZstdFrames(bytes) : []
  let summary = `${log.name}  (v${log.version}, ${log.compressed ? 'zstd' : 'plain'}, ${bytes.length} bytes`
  summary += log.compressed ? `, ${frames.length} frames)` : ')'
  console.log(summary)
  if (log.compressed) {
    const text = zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
    const header = JSON.parse(text.split('\n')[0])
    console.log(`    header.version=${header.version} header.cwd=${JSON.stringify(header.cwd)}`)
  } else {
    const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
    console.log(`    header.version=${header.version} header.cwd=${JSON.stringify(header.cwd)}`)
  }
}

const { name, header } = await readSessionHeader(target)
console.log(`\nauthoritative: ${name}`)
console.log(`cwd: ${JSON.stringify(header.cwd)}`)
