import type { ActionResult, BatchDeleteResult, SessionSummary } from '@shared/types'
import { useStore } from '../store'
import { stopTerminalTabs } from './terminalControllers'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let snapshotRequest = 0

export async function closeConversationTabs(keys: string[]): Promise<void> {
  const { closed, failed } = await stopTerminalTabs(keys)
  useStore.getState().closeTerminals(closed)
  if (failed.length > 0) useStore.getState().showToast({
    kind: 'error', message: `${failed.length} 个对话未能结束，已保留这些标签，请重试。`
  })
}

export async function loadSnapshot(force = false): Promise<boolean> {
  const request = ++snapshotRequest
  const state = useStore.getState()
  if (force) state.setRefreshing(true)
  else state.setLoading(true)
  try {
    const snapshot = force
      ? await window.api.refresh()
      : await window.api.getSnapshot()
    if (request === snapshotRequest) useStore.getState().setSnapshot(snapshot)
    return true
  } catch (error) {
    useStore.getState().showToast({
      kind: 'error',
      message: `读取会话失败：${messageOf(error)}`
    })
    return false
  } finally {
    if (request === snapshotRequest) {
      useStore.getState().setLoading(false)
      useStore.getState().setRefreshing(false)
    }
  }
}

export async function refreshSnapshot(): Promise<boolean> {
  return loadSnapshot(true)
}

export function openSessionConversation(session: SessionSummary): boolean {
  const state = useStore.getState()
  const existing = state.terminals.find(
    (terminal) => terminal.sessionId === session.id
  )
  if (existing) {
    state.selectSession(session.key, null, null, false)
    state.setActiveTerminal(existing.key)
    return true
  }

  if (
    session.source !== 'transcript' ||
    !session.projectPath ||
    !session.cwdExists
  ) {
    return false
  }

  const parts = session.projectPath.split(/[\\/]/).filter(Boolean)
  const projectName = parts[parts.length - 1] ?? session.projectKey
  state.selectSession(session.key, null, null, false)
  state.startTerminal({
    key: `resume-${session.id}-${Date.now()}`,
    cwd: session.projectPath,
    projectName,
    sessionId: session.id,
    sessionTitle: session.title,
    kind: 'resume',
    mode: state.snapshot?.settings.defaultPermissionMode ?? 'follow'
  })
  return true
}

export async function toggleFavorite(
  sessionKey: string,
  favorite: boolean
): Promise<void> {
  try {
    const favorites = await window.api.setFavorite(sessionKey, favorite)
    const state = useStore.getState()
    if (state.snapshot) {
      const sessions = state.snapshot.sessions.map((session) => {
        if (favorites.includes(session.id)) return { ...session, favorite: true }
        if (session.favorite) return { ...session, favorite: false }
        return session
      })
      state.setSnapshot({ ...state.snapshot, sessions })
    }
  } catch (error) {
    useStore.getState().showToast({
      kind: 'error',
      message: `收藏失败：${messageOf(error)}`
    })
  }
}

export async function openProjectTerminal(
  projectKey: string
): Promise<ActionResult> {
  try {
    const result = await window.api.openProjectTerminal(projectKey)
    useStore.getState().showToast({
      kind: result.ok ? 'success' : 'error',
      message: result.message ?? (result.ok ? '已在终端中打开' : '打开终端失败')
    })
    return result
  } catch (error) {
    const result = { ok: false, message: `打开终端失败：${messageOf(error)}` }
    useStore.getState().showToast({ kind: 'error', message: result.message })
    return result
  }
}

export async function resumeSession(sessionKey: string): Promise<ActionResult> {
  try {
    const result = await window.api.resumeSession(sessionKey)
    useStore.getState().showToast({
      kind: result.ok ? 'success' : 'error',
      message: result.message ?? (result.ok ? '已打开终端' : '恢复失败')
    })
    return result
  } catch (error) {
    const result = { ok: false, message: `恢复失败：${messageOf(error)}` }
    useStore.getState().showToast({ kind: 'error', message: result.message })
    return result
  }
}

export async function deleteSession(sessionKey: string): Promise<ActionResult> {
  return deleteTranscriptSessions([sessionKey])
}

export async function deleteTranscriptSessions(sessionKeys: string[]): Promise<BatchDeleteResult> {
  try {
    const result = await window.api.deleteSessions(sessionKeys)
    const state = useStore.getState()
    const deletedIds = new Set(result.deletedKeys.map((key) => key.slice(key.lastIndexOf('/') + 1)))
    state.closeTerminals(state.terminals.filter((tab) => tab.sessionId && deletedIds.has(tab.sessionId)).map((tab) => tab.key))
    if (state.selectedKey && result.deletedKeys.includes(state.selectedKey)) state.selectSession(null)
    await loadSnapshot()
    state.showToast({ kind: result.ok ? 'success' : 'error', message: result.message ?? '删除失败' })
    return result
  } catch (error) {
    const result = { ok: false, deletedKeys: [], failedKeys: sessionKeys, message: `删除失败：${messageOf(error)}` }
    useStore.getState().showToast({ kind: 'error', message: result.message })
    await loadSnapshot()
    return result
  }
}

export async function deleteProjectSessions(
  projectKey: string
): Promise<ActionResult> {
  const before = useStore.getState()
  const ids = new Set(
    (before.snapshot?.sessions ?? [])
      .filter(
        (session) =>
          session.projectKey === projectKey && session.source === 'transcript'
      )
      .map((session) => session.id)
  )
  try {
    const result = await window.api.deleteProjectSessions(projectKey)
    if (result.ok) {
      const state = useStore.getState()
      state.closeTerminals(state.terminals.filter((tab) => tab.sessionId && ids.has(tab.sessionId)).map((tab) => tab.key))
      if (
        state.view.type === 'project' &&
        state.view.projectKey === projectKey
      ) {
        state.setView({ type: 'all' })
      } else if (
        state.selectedKey &&
        ids.has(state.selectedKey.slice(state.selectedKey.lastIndexOf('/') + 1))
      ) {
        state.selectSession(null)
      }
      await loadSnapshot()
      state.showToast({
        kind: 'success',
        message: result.message ?? '项目会话已删除'
      })
    } else {
      useStore.getState().showToast({
        kind: 'error',
        message: result.message ?? '删除项目会话失败'
      })
    }
    return result
  } catch (error) {
    const result = {
      ok: false,
      message: `删除项目会话失败：${messageOf(error)}`
    }
    useStore.getState().showToast({ kind: 'error', message: result.message })
    return result
  }
}

export async function deleteHistorySessions(
  sessionKeys: string[]
): Promise<ActionResult> {
  try {
    const result = await window.api.deleteHistorySessions(sessionKeys)
    const state = useStore.getState()
    if (result.ok) {
      if (state.selectedKey && sessionKeys.includes(state.selectedKey)) {
        state.selectSession(null)
      }
      state.clearHistorySelection()
      await loadSnapshot()
      state.showToast({
        kind: 'success',
        message: result.message ?? '历史记录已删除'
      })
    } else {
      state.showToast({
        kind: 'error',
        message: result.message ?? '删除历史记录失败'
      })
    }
    return result
  } catch (error) {
    const result = {
      ok: false,
      message: `删除历史记录失败：${messageOf(error)}`
    }
    useStore.getState().showToast({ kind: 'error', message: result.message })
    return result
  }
}

export async function exportSession(sessionKey: string): Promise<void> {
  try {
    const result = await window.api.exportSession(sessionKey)
    if (result.ok) {
      useStore.getState().showToast({
        kind: 'success',
        message: result.path ? `已导出到 ${result.path}` : '导出成功'
      })
    } else if (result.message !== '已取消') {
      useStore.getState().showToast({
        kind: 'error',
        message: result.message ?? '导出失败'
      })
    }
  } catch (error) {
    useStore.getState().showToast({
      kind: 'error',
      message: `导出失败：${messageOf(error)}`
    })
  }
}

export async function openProject(projectKey: string): Promise<void> {
  try {
    const result = await window.api.openProjectFolder(projectKey)
    if (!result.ok) {
      useStore.getState().showToast({
        kind: 'error',
        message: result.message ?? '无法打开项目文件夹'
      })
    }
  } catch (error) {
    useStore.getState().showToast({
      kind: 'error',
      message: `打开失败：${messageOf(error)}`
    })
  }
}
