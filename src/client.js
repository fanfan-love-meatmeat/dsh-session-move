// dsh-session-move — client half.
//
// Three actions in the official session-row menu slot, one overlay that hosts
// their dialogs, and nothing else. No DOM queries, no title matching, no
// drag-and-drop: the slot hands us the session id, so we never guess.
//
//   sidebar.workspaces.session.menu.item  -> 移动 / AI 重命名 / 删除
//   shell.overlay                         -> 三个对话框共用的一个宿主
//
// Everything goes through POST /__sessionmove/op, so the UI and the agent tools
// share one implementation (official guidance: one operation, two callers).

window.__ModuleLoader__.load({
  id: 'dsh-session-move',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const MenuItemButton = primitives.MenuItemButton

    const NS = 'session-move'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'

    const zh = {
      'menu.move': '移动到文件夹…',
      'menu.aiRename': 'AI 重命名',
      'menu.delete': '删除会话',
      'dialog.cancel': '取消',
      'dialog.move.title': '移动会话到文件夹',
      'dialog.move.desc': '移动后，这条会话将在目标文件夹的工作目录下继续工作；历史随会话一起移动，失败会自动还原。',
      'dialog.move.target': '移到',
      'dialog.move.current': '当前位于',
      'dialog.move.confirm': '移动',
      'dialog.move.busy': '正在移动…',
      'dialog.move.done': '已移动',
      'dialog.move.same': '已经在所选文件夹中',
      'dialog.move.loading': '正在加载文件夹…',
      'dialog.move.empty': '没有可选的文件夹',
      'dialog.move.unreachable': '目录不可达',
      'dialog.rename.title': 'AI 重命名会话',
      'dialog.rename.desc': 'AI 会读一遍你在这个会话里说过的话，起一个简洁的标题。',
      'dialog.rename.busy': '正在阅读会话并重命名标题…',
      'dialog.rename.done': '已重命名为「{title}」',
      'dialog.rename.confirm': '完成',
      'dialog.delete.title': '删除会话',
      'dialog.delete.desc': '将永久删除这条会话及其对话记录，并清除项目记账。删除前会自动快照，可从快照恢复。',
      'dialog.delete.running': '⚠ 会话正在运行，删除会立即中断它的任务。',
      'dialog.delete.ack': '我已了解，确认删除',
      'dialog.delete.confirm': '删除',
      'dialog.delete.busy': '正在删除…',
      'dialog.delete.done': '已删除（快照已保留）',
      'dialog.delete.notFound': '找不到这条会话，可能已被删除。',
      'error.partial': '部分步骤未能还原，请按日志里的快照路径手工处理。',
    }

    const en = {
      'menu.move': 'Move to folder…',
      'menu.aiRename': 'AI rename',
      'menu.delete': 'Delete session',
      'dialog.cancel': 'Cancel',
      'dialog.move.title': 'Move session to folder',
      'dialog.move.desc': 'After moving, this session works in the target folder. History moves with it, and a failure is rolled back automatically.',
      'dialog.move.target': 'Move to',
      'dialog.move.current': 'Currently in',
      'dialog.move.confirm': 'Move',
      'dialog.move.busy': 'Moving…',
      'dialog.move.done': 'Moved',
      'dialog.move.same': 'Already in the selected folder',
      'dialog.move.loading': 'Loading folders…',
      'dialog.move.empty': 'No folders available',
      'dialog.move.unreachable': 'directory unreachable',
      'dialog.rename.title': 'AI rename session',
      'dialog.rename.desc': 'The model reads what you said in this session and proposes a short title.',
      'dialog.rename.busy': 'Reading the conversation…',
      'dialog.rename.done': 'Renamed to “{title}”',
      'dialog.rename.confirm': 'Done',
      'dialog.delete.title': 'Delete session',
      'dialog.delete.desc': 'Permanently deletes this session and its conversation records, and clears the workspace accounting. A snapshot is taken first and can be restored.',
      'dialog.delete.running': '⚠ This session is running; deleting it interrupts its task immediately.',
      'dialog.delete.ack': 'I understand. Delete it.',
      'dialog.delete.confirm': 'Delete',
      'dialog.delete.busy': 'Deleting…',
      'dialog.delete.done': 'Deleted (snapshot kept)',
      'dialog.delete.notFound': 'This session was not found; it may already be gone.',
      'error.partial': 'Some steps could not be undone. Use the snapshot path from the journal.',
    }

    // ---------------------------------------------------------------- dialog store

    const listeners = new Set()
    let pending = null
    let hostCtx = null

    function notify() {
      for (const listener of listeners) {
        try {
          listener()
        } catch { /* a subscriber must never break the menu */ }
      }
    }

    function openDialog(kind, sessionId, title) {
      pending = { kind, sessionId, title: title ?? '', key: Date.now() + Math.random() }
      notify()
    }

    function closeDialog() {
      pending = null
      notify()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    async function refreshSessions() {
      try {
        await hostCtx?.sessions?.refresh?.()
      } catch { /* the list just stays as it was */ }
    }

    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? ''))
    }

    // ---------------------------------------------------------------- operation call

    async function callOp(op, args) {
      const response = await fetch('/__sessionmove/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args }),
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch { /* empty body */ }
      if (!response.ok || payload.ok !== true) {
        const error = new Error(payload.message || 'HTTP ' + response.status)
        error.code = payload.code
        error.detail = payload.detail
        throw error
      }
      return payload.result
    }

    // ---------------------------------------------------------------- styles

    const S = {
      backdrop: {
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.45)', zIndex: 3000,
      },
      panel: {
        minWidth: 380, maxWidth: 520, padding: '18px 20px', borderRadius: 12,
        background: 'var(--dsw-alias-bg-base, #ffffff)', color: 'var(--dsw-alias-label-primary, #111)',
        boxShadow: '0 12px 40px rgba(0,0,0,.28)', fontSize: 13, lineHeight: '20px',
      },
      title: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
      desc: { margin: '0 0 12px', color: 'var(--dsw-alias-label-secondary, #8a8a8e)' },
      meta: { margin: '0 0 10px', color: 'var(--dsw-alias-label-secondary, #8a8a8e)' },
      list: { maxHeight: 260, overflowY: 'auto', margin: '0 0 8px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' },
      hint: { color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 12 },
      warn: { color: 'var(--dsw-alias-state-warn-primary, #f5a524)', margin: '6px 0 0' },
      error: { color: 'var(--dsw-alias-state-error-primary, #e5484d)', marginTop: 8 },
      done: { color: 'var(--dsw-alias-state-success-primary, #30a46c)', marginTop: 8, fontWeight: 500 },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
      button: {
        padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
      },
      primary: {
        padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #4f7cff)',
        background: 'var(--dsw-alias-state-business-primary, #4f7cff)', color: '#fff',
      },
      danger: {
        padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'var(--dsw-alias-state-error-primary, #e5484d)', color: '#fff',
      },
    }

    function dimmed(style, disabled) {
      return disabled ? Object.assign({}, style, { opacity: 0.5, cursor: 'default' }) : style
    }

    // ---------------------------------------------------------------- dialog shell

    function Dialog(props) {
      const onClose = props.onClose
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])

      return React.createElement('div', { style: S.backdrop, onClick: onClose },
        React.createElement('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title,
          style: S.panel,
          onClick: (event) => event.stopPropagation(),
        },
        React.createElement('h2', { style: S.title }, props.title),
        props.description ? React.createElement('p', { style: S.desc }, props.description) : null,
        props.children,
        React.createElement('div', { style: S.footer }, props.footer)))
    }

    // ---------------------------------------------------------------- move body

    function MoveBody(props) {
      const t = props.t
      const [state, setState] = useState({ phase: 'loading', workspaces: [], current: null, selected: '', busy: false, error: null, done: false })

      useEffect(() => {
        let cancelled = false
        const query = props.sessionId ? '?sessionId=' + encodeURIComponent(props.sessionId) : ''
        fetch('/__sessionmove/info' + query)
          .then((response) => response.json())
          .then((payload) => {
            if (cancelled) return
            if (payload && payload.ok === true) {
              setState((previous) => Object.assign({}, previous, {
                phase: 'ready',
                workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
                current: payload.currentWorkspaceId ?? null,
              }))
            } else {
              setState((previous) => Object.assign({}, previous, { phase: 'ready', error: t('dialog.move.empty') }))
            }
          })
          .catch(() => {
            if (!cancelled) setState((previous) => Object.assign({}, previous, { phase: 'ready', error: t('dialog.move.empty') }))
          })
        return () => { cancelled = true }
      }, [props.sessionId])

      const same = state.selected !== '' && state.selected === state.current

      const confirm = useCallback(() => {
        if (state.busy || state.selected === '' || same) return
        setState((previous) => Object.assign({}, previous, { busy: true, error: null }))
        callOp('move', { sessionId: props.sessionId, targetWorkspaceId: state.selected })
          .then(async (result) => {
            await refreshSessions()
            setState((previous) => Object.assign({}, previous, { busy: false, done: true, result }))
            props.onDone()
          })
          .catch((error) => {
            setState((previous) => Object.assign({}, previous, {
              busy: false,
              error: error.code === 'PARTIAL' ? t('error.partial') + ' ' + (error.detail?.snapshot ?? '') : error.message,
            }))
          })
      }, [state.busy, state.selected, same, props.sessionId])

      if (state.done) {
        return React.createElement(React.Fragment, null,
          React.createElement('div', { style: S.done }, t('dialog.move.done')),
          React.createElement('div', { style: S.footer },
            React.createElement('button', { type: 'button', style: S.primary, onClick: props.onClose }, t('dialog.cancel'))))
      }

      const rows = state.workspaces.map((workspace) => React.createElement('label', { key: workspace.workspaceId, style: S.row },
        React.createElement('input', {
          type: 'radio',
          name: 'session-move-target',
          value: workspace.workspaceId,
          checked: state.selected === workspace.workspaceId,
          disabled: state.busy,
          onChange: (event) => setState((previous) => Object.assign({}, previous, { selected: event.target.value })),
        }),
        React.createElement('span', null,
          workspace.title || workspace.path || workspace.workspaceId,
          workspace.reachable === false
            ? React.createElement('span', { style: S.hint }, ' ' + t('dialog.move.unreachable'))
            : null)))

      const current = state.workspaces.find((workspace) => workspace.workspaceId === state.current)

      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: S.meta }, props.title || props.sessionId),
        current ? React.createElement('div', { style: S.meta }, t('dialog.move.current') + '：' + (current.title || current.path)) : null,
        state.phase === 'loading'
          ? React.createElement('div', { style: S.hint }, t('dialog.move.loading'))
          : React.createElement('div', { style: S.list, role: 'radiogroup', 'aria-label': t('dialog.move.target') },
            rows.length === 0 ? React.createElement('div', { style: S.hint }, t('dialog.move.empty')) : rows),
        same ? React.createElement('div', { style: S.warn }, t('dialog.move.same')) : null,
        state.error ? React.createElement('div', { style: S.error, role: 'alert' }, state.error) : null,
        React.createElement('div', { style: S.footer },
          React.createElement('button', { type: 'button', disabled: state.busy, style: dimmed(S.button, state.busy), onClick: props.onClose }, t('dialog.cancel')),
          React.createElement('button', {
            type: 'button',
            disabled: state.busy || state.selected === '' || same,
            style: dimmed(S.primary, state.busy || state.selected === '' || same),
            onClick: confirm,
          }, state.busy ? t('dialog.move.busy') : t('dialog.move.confirm'))))
    }

    // ---------------------------------------------------------------- rename body

    function RenameBody(props) {
      const t = props.t
      const [state, setState] = useState({ busy: true, error: null, title: null })

      useEffect(() => {
        let cancelled = false
        callOp('rename', { sessionId: props.sessionId })
          .then(async (result) => {
            await refreshSessions()
            if (!cancelled) setState({ busy: false, error: null, title: result.title ?? '' })
          })
          .catch((error) => {
            if (!cancelled) setState({ busy: false, error: error.message, title: null })
          })
        return () => { cancelled = true }
      }, [props.sessionId])

      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: S.meta }, props.title || props.sessionId),
        state.busy ? React.createElement('div', { style: S.hint }, t('dialog.rename.busy')) : null,
        state.title !== null
          ? React.createElement('div', { style: S.done }, fill(t('dialog.rename.done'), { title: state.title }))
          : null,
        state.error ? React.createElement('div', { style: S.error, role: 'alert' }, state.error) : null,
        React.createElement('div', { style: S.footer },
          React.createElement('button', { type: 'button', style: S.primary, onClick: props.onClose }, t('dialog.rename.confirm'))))
    }

    // ---------------------------------------------------------------- delete body

    function DeleteBody(props) {
      const t = props.t
      const [state, setState] = useState({ ack: false, busy: false, error: null, done: false })

      if (!props.sessionId) {
        return React.createElement(React.Fragment, null,
          React.createElement('div', { style: S.error }, t('dialog.delete.notFound')),
          React.createElement('div', { style: S.footer },
            React.createElement('button', { type: 'button', style: S.button, onClick: props.onClose }, t('dialog.cancel'))))
      }

      if (state.done) {
        return React.createElement(React.Fragment, null,
          React.createElement('div', { style: S.done }, t('dialog.delete.done')),
          React.createElement('div', { style: S.footer },
            React.createElement('button', { type: 'button', style: S.primary, onClick: props.onClose }, t('dialog.rename.confirm'))))
      }

      const confirm = () => {
        if (state.busy || !state.ack) return
        setState((previous) => Object.assign({}, previous, { busy: true, error: null }))
        callOp('delete', { sessionId: props.sessionId })
          .then(async () => {
            await refreshSessions()
            setState((previous) => Object.assign({}, previous, { busy: false, done: true }))
          })
          .catch((error) => {
            setState((previous) => Object.assign({}, previous, {
              busy: false,
              error: error.code === 'PARTIAL' ? t('error.partial') + ' ' + (error.detail?.snapshot ?? '') : error.message,
            }))
          })
      }

      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: S.meta }, props.title || props.sessionId),
        React.createElement('label', { style: S.row },
          React.createElement('input', {
            type: 'checkbox',
            checked: state.ack,
            disabled: state.busy,
            onChange: (event) => setState((previous) => Object.assign({}, previous, { ack: event.target.checked })),
          }),
          React.createElement('span', null, t('dialog.delete.ack'))),
        state.error ? React.createElement('div', { style: S.error, role: 'alert' }, state.error) : null,
        React.createElement('div', { style: S.footer },
          React.createElement('button', { type: 'button', disabled: state.busy, style: dimmed(S.button, state.busy), onClick: props.onClose }, t('dialog.cancel')),
          React.createElement('button', {
            type: 'button',
            disabled: state.busy || !state.ack,
            style: dimmed(S.danger, state.busy || !state.ack),
            onClick: confirm,
          }, state.busy ? t('dialog.delete.busy') : t('dialog.delete.confirm'))))
    }

    // ---------------------------------------------------------------- overlay host

    function DialogHost(props) {
      const t = props.t
      const [current, setCurrent] = useState(pending)

      useEffect(() => subscribe(() => setCurrent(pending)), [])

      if (current === null) return null

      const body = current.kind === 'move'
        ? React.createElement(MoveBody, { sessionId: current.sessionId, title: current.title, t, onClose: closeDialog, onDone: () => {} })
        : current.kind === 'rename'
          ? React.createElement(RenameBody, { sessionId: current.sessionId, title: current.title, t, onClose: closeDialog })
          : React.createElement(DeleteBody, { sessionId: current.sessionId, title: current.title, t, onClose: closeDialog })

      const meta = current.kind === 'move' ? 'dialog.move' : current.kind === 'rename' ? 'dialog.rename' : 'dialog.delete'

      return React.createElement(Dialog, {
        title: t(meta + '.title'),
        description: t(meta + '.desc'),
        onClose: closeDialog,
        footer: [],
      }, body)
    }

    // ---------------------------------------------------------------- menu items

    function makeMenuItem(kind, order, labelKey, options) {
      const Component = (props) => {
        const setMenuOpen = props.useMenuOpenState()[1]
        const t = props.t
        return React.createElement(MenuItemButton, {
          separatorBefore: options && options.separatorBefore === true,
          onSelect: () => {
            try {
              setMenuOpen(false)
            } catch { /* the menu is already closed */ }
            openDialog(kind, props.sessionId, props.displayTitle)
          },
        }, t(labelKey))
      }
      return {
        name: MENU_SLOT,
        id: 'session-move.' + kind,
        order,
        locale: NS,
        inject: () => ({}),
        Component,
      }
    }

    const MENU_ITEMS = [
      makeMenuItem('move', 350, 'menu.move'),
      makeMenuItem('rename', 360, 'menu.aiRename'),
      makeMenuItem('delete', 900, 'menu.delete', { separatorBefore: true }),
    ]

    // ---------------------------------------------------------------- apply

    function apply(ctx) {
      hostCtx = ctx

      ctx.effect(() => ctx.locale.register(NS, { zh, en }))

      for (const item of MENU_ITEMS) {
        ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
          name: item.name,
          id: item.id,
          order: item.order,
          locale: item.locale,
          inject: item.inject,
        }, item.Component))
      }

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: 'session-move.dialog',
        order: 100,
        locale: NS,
      }, DialogHost))
    }

    return { apply, inject: ['slots', 'locale', 'sessions'] }
  },
})
