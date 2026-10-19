// AI-rename one session: summarise the human messages, then apply the title.
//
// Two things this deliberately does NOT do:
//   * it does not snapshot (nothing on disk moves; a bad title is fixed by
//     renaming again, and the journal already keeps the old title);
//   * it does not leave a cold session awake any longer than necessary.

import { runTransaction, OpError, STATUS } from '../txn.js'
import { buildTitleInput, collectUserMessages, sampleMessages } from '../core/title.js'

const SESSION_ID = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OK = { ok: true, reason: '' }

/** Route from the session's own last request, else the configured pair. */
function resolveRoute(session, config) {
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const route = header === undefined || header === null ? undefined : header.config
  if (route !== undefined && route !== null && typeof route.provider === 'string' && typeof route.model === 'string') {
    return { provider: route.provider, model: route.model }
  }
  if (typeof config.provider === 'string' && typeof config.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  return undefined
}

/**
 * @param {object} runtime ports + journal + clock + config
 */
export function createRename(runtime) {
  const { clock, journal, logger, sessionGateway, titleService, llm, config } = runtime

  return async function rename(input) {
    const sessionId = String(input.sessionId ?? '').trim()
    const source = input.source ?? 'ui'
    if (!SESSION_ID.test(sessionId)) throw new OpError('INVALID', '参数错误：会话 id 不合法')

    let session = sessionGateway.get(sessionId)
    let handle
    if (session === undefined) {
      handle = await sessionGateway.resume(sessionId)
      session = sessionGateway.get(sessionId)
      if (session === undefined) {
        handle?.dispose()
        throw new OpError('INVALID', '会话不存在，且无法拉起')
      }
    }

    // NOTE — on success the resumed session is deliberately left live.
    //
    // Disposing the handle tears the agent/session down and emits session/disposed.
    // The Web client reads that as "this session is gone" and drops its sidebar row
    // until the next full list re-projection (it came back only after creating some
    // other session). A quietly-resumed session costs almost nothing; a vanishing
    // row does not — so we wake it, rename it, and leave it awake.
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      const messages = collectUserMessages(events)
      if (messages.length === 0) throw new OpError('INVALID', '该会话没有可概括的用户消息')
      const sampled = sampleMessages(messages, config.maxInputBytes)

      const route = resolveRoute(session, config)
      if (route === undefined) {
        throw new OpError('INVALID', '无法确定模型：该会话没有请求记录，插件也未配置 provider/model')
      }

      const before = typeof session.title === 'string' ? session.title : null
      const meta = {
        from: before,
        to: null,
        route: route.provider + '/' + route.model,
        resumed: handle !== undefined,
      }

      const result = await runTransaction({
        kind: 'rename',
        sessionId,
        title: before,
        source,
        clock,
        journal,
        logger,
        requiresSnapshot: false,
        meta,
        steps: [{
          name: 'rename',
          async run() {
            const generated = await llm.title({
              route,
              input: buildTitleInput(sampled),
              messageCount: sampled.length,
              targetWords: config.targetWords,
              targetCjkCharacters: config.targetCjkCharacters,
              maxOutputTokens: config.maxOutputTokens,
              timeoutMs: config.timeoutMs,
              sessionId,
            })
            const accepted = titleService.apply(session, generated)
            meta.to = accepted
          },
          async verify() {
            return meta.to === null ? { ok: false, reason: '标题没有被写入' } : OK
          },
        }],
        verify: async () => (meta.to === null ? { ok: false, reason: '标题没有被写入' } : OK),
      })

      return { status: result.status, sessionId, title: meta.to, from: before }
    } catch (error) {
      // A resumed session that could not be renamed is released again: nothing succeeded.
      handle?.dispose()
      throw error
    }
  }
}
