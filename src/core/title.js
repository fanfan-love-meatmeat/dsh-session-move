// Turning a conversation into the input for a title model.
//
// Only human text messages matter: the title answers "what did the user want",
// and assistant output is noise for that question (and far bigger).

/** Human-sourced, text-bearing user messages, in log order. */
export function collectUserMessages(events) {
  const out = []
  for (const event of events) {
    if (event === null || event === undefined) continue
    if (event.type !== 'user/message') continue
    const data = event.data
    if (data === null || data === undefined) continue
    if (data.source === null || data.source === undefined || data.source.kind !== 'user') continue
    const content = Array.isArray(data.content) ? data.content : []
    const text = content
      .filter((block) => block !== null && block !== undefined && block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (typeof text !== 'string' || text.trim().length === 0) continue
    out.push({ seq: event.seq, text })
  }
  return out
}

const FRAME_PREFIX = 'Generate the session title from this JSON array of human messages:\n'

function framedBytes(candidates) {
  return Buffer.byteLength(FRAME_PREFIX + JSON.stringify(candidates), 'utf8')
}

/**
 * Keep every message when it fits; otherwise sample EVENLY across the whole
 * timeline (first and last always kept) so the model sees the arc of the
 * conversation rather than just its opening.
 */
export function sampleMessages(messages, maxInputBytes) {
  if (messages.length === 0) return messages
  if (framedBytes(messages) <= maxInputBytes) return messages

  const pick = (count) => {
    if (count >= messages.length) return messages
    const picked = []
    for (let i = 0; i < count; i++) {
      const index = Math.round((i / (count - 1)) * (messages.length - 1))
      picked.push(messages[index])
    }
    const seen = new Set()
    return picked.filter((entry) => {
      if (seen.has(entry.seq)) return false
      seen.add(entry.seq)
      return true
    })
  }

  let low = 1
  let high = messages.length
  let best = [messages[0]]
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = pick(middle)
    if (framedBytes(candidate) <= maxInputBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/** The user-facing prompt body for a sampled set. */
export function buildTitleInput(sampled) {
  return FRAME_PREFIX + JSON.stringify(sampled)
}
