// Title generation against the host's LLM service.
//
// Isolated in an adapter because it needs @deepseek-ai/dsh-llm,
// dsh-session-title and dsh-timeout; nothing else in src/ may import those.

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import { deadline } from '@deepseek-ai/dsh-timeout'

const SYSTEM_PROMPT = [
  'You are naming an AI coding-assistant chat session.',
  'Read the human messages (a sample of the conversation) and write ONE concise title that captures what the user wanted.',
  'Do NOT repeat the literal opening words of the conversation; write a summary title.',
  'IMPORTANT — fix typos: the source messages are raw user input. Always use the CORRECT, standard word in the title, never a misspelling.',
  'Be CONCISE: a short title, not a sentence.',
  'Reply with only the title on one line: plain text, no quotes, no prefix, no explanation, no Markdown.',
  'Use the language of the messages (Chinese messages -> Chinese title).',
  'Aim for about {cjk} CJK characters, or {words} words for other languages.',
].join('\n')

/**
 * @param {object} ctx cordis context
 */
export function createLlm(ctx) {
  return {
    /**
     * @param {object} request
     * @param {{provider: string, model: string}} request.route
     * @param {string} request.input        already-framed message array
     * @param {number} request.targetWords
     * @param {number} request.targetCjkCharacters
     * @param {number} request.maxOutputTokens
     * @param {number} request.timeoutMs
     * @param {string} request.sessionId
     * @returns {Promise<string>} a cleaned, single-line title
     */
    async title(request) {
      const service = ctx.get('llm')
      if (service === undefined || typeof service.stream !== 'function') {
        throw new Error('LLM service is unavailable')
      }

      const system = SYSTEM_PROMPT
        .replace('{cjk}', String(request.targetCjkCharacters))
        .replace('{words}', String(request.targetWords))

      const messages = [createUserMessage({
        content: [{ type: 'text', text: request.input }],
        source: { kind: 'plugin', plugin: 'dsh-session-move' },
      })]

      const callDeadline = deadline(new AbortController().signal, request.timeoutMs, 'session-move-title-timeout')
      const assembler = new BlockAssembler()
      const stream = service.stream({
        provider: request.route.provider,
        model: request.route.model,
        messages,
        system,
        maxTokens: request.maxOutputTokens,
        sessionId: request.sessionId,
        purpose: 'session-title',
        signal: callDeadline.signal,
      })

      for await (const chunk of stream) {
        callDeadline.signal.throwIfAborted()
        assembler.push(chunk)
      }
      callDeadline.signal.throwIfAborted()

      // FinishReason kinds are stop / tool-calls / max-tokens / aborted / error
      // (dsh-llm types). A truncated title is still a usable one-line title, so
      // max-tokens is ACCEPTED — only the genuinely broken endings are refused.
      // (An older check tested for 'length', which no provider ever reports.)
      const finish = assembler.finish
      const kind = finish === undefined || finish === null ? 'stop' : finish.kind
      const rejected = new Set(['tool-calls', 'aborted', 'error'])
      if (rejected.has(kind)) throw new Error('title generation stopped early: ' + kind)

      const text = assembler.blocks()
        .filter((block) => block !== null && block !== undefined && block.type === 'text')
        .map((block) => block.text)
        .join(' ')
      if (text.trim().length === 0) {
        throw new Error(kind === 'max-tokens'
          ? '模型把输出预算用完了但没有给出标题（可调大插件配置里的 maxOutputTokens）'
          : 'title model produced no text')
      }

      const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
      if (title.length === 0) throw new Error('title model produced no text')
      return title
    },
  }
}
