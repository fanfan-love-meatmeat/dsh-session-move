// Pure-core tests: no DSH, no filesystem, no stubs.
// Run: node tools/test-core.mjs

import { constants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import path from 'node:path'
import assert from 'node:assert'

import { encodeSegment, projectKey } from '../src/core/slug.js'
import {
  scanZstdFrames, readHeaderFrame, patchHeaderCwd, parseGenerationName, pickGenerations,
} from '../src/core/log.js'
import {
  expectedSessionDir, checkLocation, checkAccounting, checkCacheIdentity, samePath,
} from '../src/core/invariants.js'

const compress = promisify(zstdCompress)
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

// ---------------------------------------------------------------- slug

check('projectKey: plain windows path', () => {
  assert.strictEqual(
    projectKey('C:\\work\\demo-project'),
    '--C-work-demo-project--',
  )
})

check('projectKey: CJK escaped as uppercase hex', () => {
  assert.strictEqual(
    projectKey('C:\\work\\测试\\标题'),
    '--C-work-~6D4B~8BD5-~6807~9898--',
  )
})

check('projectKey: dot segments are NOT special-cased', () => {
  assert.strictEqual(projectKey('..'), '--..--')
})

check('projectKey: tilde self-escapes', () => {
  assert.strictEqual(projectKey('~~~'), '--~007E~007E~007E--')
})

check('projectKey: separator runs collapse', () => {
  assert.strictEqual(projectKey('C:\\\\a\\\\\\\\b'), '--C-a-b--')
})

check('projectKey: empty input throws', () => {
  assert.throws(() => projectKey(''))
})

check('encodeSegment: safe chars pass through', () => {
  assert.strictEqual(encodeSegment('4b8cd0a9-547e-44df-80d6-136308e9abaf'), '4b8cd0a9-547e-44df-80d6-136308e9abaf')
})

check('encodeSegment: traversal is neutralized', () => {
  assert.strictEqual(encodeSegment('.'), '~002E')
  assert.strictEqual(encodeSegment('..'), '~002E~002E')
})

// ---------------------------------------------------------- generation names

check('parse: v0 is the suffix-only name, for the CONFIGURED encoding', () => {
  assert.strictEqual(parseGenerationName('session.jsonl.zstd'), 0)
  assert.strictEqual(parseGenerationName('session.jsonl', 'none'), 0)
  // A plain file when zstd is configured belongs to the other encoding: not a match.
  assert.strictEqual(parseGenerationName('session.jsonl'), undefined)
})

check('parse: vN canonical', () => {
  assert.strictEqual(parseGenerationName('session.v3.jsonl.zstd'), 3)
  assert.strictEqual(parseGenerationName('session.v12.jsonl.zstd'), 12)
})

check('parse: .v0 and zero-padded are NOT canonical', () => {
  assert.strictEqual(parseGenerationName('session.v0.jsonl.zstd'), undefined)
  assert.strictEqual(parseGenerationName('session.v01.jsonl.zstd'), undefined)
  assert.strictEqual(parseGenerationName('session.V3.jsonl.zstd'), undefined)
})

check('parse: temp and foreign names are rejected', () => {
  assert.strictEqual(parseGenerationName('session.v3.jsonl.zstd.move-tmp-99'), undefined)
  assert.strictEqual(parseGenerationName('session.v3.jsonl'), undefined)
  assert.strictEqual(parseGenerationName('session.v3.jsonl.zstd', 'none'), undefined)
})

check('pick: newest first, non-canonical filtered', () => {
  const names = [
    'session.jsonl.zstd',
    'session.v3.jsonl.zstd',
    'session.v4.jsonl.zstd',
    'session.v0.jsonl.zstd',
    'notes.txt',
  ]
  assert.deepStrictEqual(
    pickGenerations(names).map((entry) => entry.version),
    [4, 3, 0],
  )
})

// --------------------------------------------------------------- frames

const HEADER = {
  type: 'session',
  version: 4,
  id: '0a42141c-1111-2222-3333-444455556666',
  createdAt: 1792379781409,
  cwd: 'C:\\work\\project-old',
  isSeeded: false,
  delegationDepth: 1,
  agentPreset: 'ptc',
}

async function makeLog() {
  const headerFrame = await compress(JSON.stringify(HEADER) + '\n', CHECKSUM)
  const bodyOne = await compress('{"seq":1,"type":"user/message"}\n', CHECKSUM)
  const bodyTwo = await compress('{"seq":2,"type":"assistant/message"}\n', CHECKSUM)
  return Buffer.concat([headerFrame, bodyOne, bodyTwo])
}

await checkAsync('frames: three complete frames found', async () => {
  const buffer = await makeLog()
  const { frames } = scanZstdFrames(buffer)
  assert.strictEqual(frames.length, 3)
  assert.strictEqual(frames[0].start, 0)
  assert.strictEqual(frames[2].end, buffer.length)
})

await checkAsync('frames: header round-trips', async () => {
  const buffer = await makeLog()
  const { frames } = scanZstdFrames(buffer)
  const header = await readHeaderFrame(buffer.subarray(frames[0].start, frames[0].end))
  assert.strictEqual(header.id, HEADER.id)
  assert.strictEqual(header.cwd, HEADER.cwd)
})

await checkAsync('patch: only cwd changes, trailing bytes are byte-identical', async () => {
  const buffer = await makeLog()
  const { frames } = scanZstdFrames(buffer)
  const result = await patchHeaderCwd(buffer, 'C:\\work\\project-new')
  assert.strictEqual(result.header.cwd, 'C:\\work\\project-new')
  assert.strictEqual(result.header.id, HEADER.id)
  assert.strictEqual(result.header.createdAt, HEADER.createdAt)
  assert.strictEqual(result.header.version, 4)

  const patchedFrames = scanZstdFrames(result.buffer).frames
  assert.strictEqual(patchedFrames.length, 3)
  const tail = result.buffer.subarray(patchedFrames[0].end)
  assert.ok(tail.equals(buffer.subarray(frames[0].end)), 'trailing frames must not change')
})

await checkAsync('patch: idempotent', async () => {
  const buffer = await makeLog()
  const once = await patchHeaderCwd(buffer, 'D:\\x')
  const twice = await patchHeaderCwd(once.buffer, 'D:\\x')
  assert.strictEqual(twice.header.cwd, 'D:\\x')
  assert.strictEqual(scanZstdFrames(twice.buffer).frames.length, 3)
})

await checkAsync('patch: torn tail bytes are preserved', async () => {
  const buffer = Buffer.concat([await makeLog(), Buffer.from([0x28, 0xb5])])
  const result = await patchHeaderCwd(buffer, 'D:\\y')
  assert.ok(result.buffer.subarray(result.buffer.length - 2).equals(Buffer.from([0x28, 0xb5])))
})

await checkAsync('patch: refuses a log with no complete frame', async () => {
  await assert.rejects(() => patchHeaderCwd(Buffer.from([0x00, 0x01, 0x02]), 'D:\\z'))
})

// ----------------------------------------------------------- invariants

const ROOT = path.join('C:', 'home', 'sessions')

check('I1: expected dir is projectKey(cwd)/encodeSegment(id)', () => {
  const dir = expectedSessionDir(ROOT, { ...HEADER, cwd: 'C:\\work\\project-old' })
  assert.strictEqual(dir, path.join(ROOT, projectKey('C:\\work\\project-old'), encodeSegment(HEADER.id)))
})

check('I1: missing cwd is a hard error', () => {
  assert.throws(() => expectedSessionDir(ROOT, { id: 'x' }))
})

check('I1: match and mismatch', () => {
  const dir = expectedSessionDir(ROOT, HEADER)
  assert.strictEqual(checkLocation(ROOT, HEADER, dir).ok, true)
  const other = expectedSessionDir(ROOT, { ...HEADER, cwd: 'D:\\elsewhere' })
  assert.strictEqual(checkLocation(ROOT, HEADER, other).ok, false)
})

check('samePath: platform aware and separator tolerant', () => {
  assert.strictEqual(samePath('D:\\a\\b\\', 'D:\\a\\b'), true)
  if (process.platform === 'win32') assert.strictEqual(samePath('D:\\A', 'd:\\a'), true)
  assert.strictEqual(samePath('D:\\a', 'D:\\b'), false)
})

check('I2: accounted once, in the target only', () => {
  const workspaces = [
    { workspaceId: 'old', sessionIds: [] },
    { workspaceId: 'new', sessionIds: ['s1'] },
  ]
  assert.strictEqual(checkAccounting(workspaces, 's1', 'new').ok, true)
})

check('I2: still accounted in the old workspace fails', () => {
  const workspaces = [
    { workspaceId: 'old', sessionIds: ['s1'] },
    { workspaceId: 'new', sessionIds: ['s1'] },
  ]
  const result = checkAccounting(workspaces, 's1', 'new')
  assert.strictEqual(result.ok, false)
  assert.ok(result.reason.includes('old'))
})

check('I2: absent from the target fails', () => {
  assert.strictEqual(checkAccounting([{ workspaceId: 'new', sessionIds: [] }], 's1', 'new').ok, false)
})

check('I3: absent record is fine, matching identity is fine, mismatch fails', () => {
  assert.strictEqual(checkCacheIdentity(undefined, HEADER).ok, true)
  const ok = { identity: { createdAt: HEADER.createdAt, cwd: HEADER.cwd, isSeeded: HEADER.isSeeded } }
  assert.strictEqual(checkCacheIdentity(ok, HEADER).ok, true)
  const stale = { identity: { createdAt: HEADER.createdAt, cwd: 'D:\\old', isSeeded: HEADER.isSeeded } }
  assert.strictEqual(checkCacheIdentity(stale, HEADER).ok, false)
})

// ---------------------------------------------------------------- report

if (failures.length > 0) {
  console.log('FAILED ' + failures.length + ' / ' + (passed + failures.length))
  for (const line of failures) console.log('  x ' + line)
  process.exit(1)
}
console.log('core: ' + passed + ' passed, 0 failed')
