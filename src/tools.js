// The three agent-facing tools: thin parameter conversion over the same
// operations the UI calls. A failure is thrown, never returned as text, so the
// model cannot mistake it for success.

import { defineTool } from '@deepseek-ai/dsh-tools'

const SESSION_PARAM = {
  type: 'string',
  required: true,
  description: 'The session id (uuid or session-<uuid> form).',
}

const OUTPUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: value }]
  },
}

/**
 * @param {object} ctx cordis context
 * @param {object} ops move | delete | rename
 */
export function registerTools(ctx, ops) {
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition))

  register(defineTool({
    name: 'workbench_session_move',
    description: 'Move one session to another workspace (folder) of this workbench. The session stops running first, its log directory is relocated, its header cwd is rewritten, and the workspace accounting plus projection cache are re-aligned. The session then works in the target directory.',
    parameters: {
      sessionId: SESSION_PARAM,
      workspaceId: {
        type: 'string',
        required: true,
        description: 'Target workspace id (list them with the /__sessionmove/info endpoint).',
      },
    },
    output: OUTPUT,
    async execute(args) {
      const result = await ops.move({
        sessionId: String(args.sessionId ?? '').trim(),
        targetWorkspaceId: String(args.workspaceId ?? '').trim(),
        source: 'tool',
      })
      return [
        'moved: ' + result.status,
        'session: ' + result.sessionId,
        'from: ' + String(result.from ?? '(none)'),
        'to: ' + String(result.to ?? '(none)'),
      ].join('\n')
    },
  }))

  register(defineTool({
    name: 'workbench_session_delete',
    description: 'Permanently delete one session of this workbench: stop it if running, snapshot it first, remove its log directory, and drop its projection-cache row and workspace accounting. The snapshot stays on disk and can be restored with a script.',
    parameters: { sessionId: SESSION_PARAM },
    output: OUTPUT,
    async execute(args) {
      const result = await ops.delete({
        sessionId: String(args.sessionId ?? '').trim(),
        source: 'tool',
      })
      return [
        'deleted: ' + result.sessionId,
        'status: ' + result.status,
        'snapshot: kept (see the plugin journal)',
      ].join('\n')
    },
  }))

  register(defineTool({
    name: 'workbench_session_rename_ai',
    description: 'AI-rename one session: the model reads the human messages of the conversation and applies a concise title. Cold sessions are woken for the rename and released afterwards.',
    parameters: { sessionId: SESSION_PARAM },
    output: OUTPUT,
    async execute(args) {
      const result = await ops.rename({
        sessionId: String(args.sessionId ?? '').trim(),
        source: 'tool',
      })
      return [
        'renamed: ' + result.sessionId,
        'title: ' + String(result.title ?? '(unchanged)'),
        'previous: ' + String(result.from ?? '(none)'),
      ].join('\n')
    },
  }))
}
