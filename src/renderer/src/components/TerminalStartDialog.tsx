import { useEffect, useState } from 'react'
import type { TerminalPermissionMode } from '@shared/types'
import { useStore } from '../store'
import { useDialog } from '../lib/useDialog'

const MODE_OPTIONS: Array<{ value: TerminalPermissionMode; label: string }> = [
  { value: 'follow', label: '跟随 Claude 设置（默认）' },
  { value: 'manual', label: 'manual — 逐次询问' },
  { value: 'auto', label: 'auto — 自动判断' },
  { value: 'acceptEdits', label: 'acceptEdits — 自动接受编辑' },
  { value: 'plan', label: 'plan — 计划模式' },
  { value: 'dontAsk', label: 'dontAsk — 不询问' }
]

export default function TerminalStartDialog(): React.JSX.Element | null {
  const request = useStore((state) => state.terminalDialog)
  const terminalCount = useStore((state) => state.terminals.length)
  const defaultMode = useStore(
    (state) => state.snapshot?.settings.defaultPermissionMode ?? 'follow'
  )
  const closeDialog = useStore((state) => state.closeTerminalDialog)
  const startTerminal = useStore((state) => state.startTerminal)
  const [mode, setMode] = useState<TerminalPermissionMode>(defaultMode)
  const dialogRef = useDialog(Boolean(request), closeDialog)

  useEffect(() => {
    if (request) setMode(defaultMode)
  }, [request, defaultMode])

  if (!request) return null

  const title =
    request.kind === 'resume'
      ? '在应用内恢复对话'
      : request.kind === 'new-project'
        ? '在新项目文件夹中新建对话'
        : '在项目内新建对话'

  const description =
    request.kind === 'resume'
      ? `恢复会话：${request.sessionTitle ?? request.projectName}`
      : request.kind === 'new-project'
        ? `新项目：${request.projectName}`
        : `项目：${request.projectName}`

  return (
    <div className="overlay" onMouseDown={closeDialog}>
      <div
        className="dialog terminal-start-dialog"
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="terminal-start-path">{request.cwd}</div>

        {request.kind === 'new-project' && (
          <p className="dialog-hint">
            发送第一条消息后，这个项目会自动出现在左侧项目列表。
          </p>
        )}
        <p className="dialog-hint">
          将在新的终端标签页中打开
          {terminalCount > 0 ? `，当前已打开 ${terminalCount} 个对话` : ''}。
        </p>

        <label className="dialog-field">
          <span>权限模式</span>
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as TerminalPermissionMode)
            }
          >
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="dialog-hint">
          运行中可在 Claude 终端内用 Shift+Tab 切换权限模式；具体工具授权由 Claude 原生提示处理。
        </p>

        <div className="dialog-actions">
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => {
              startTerminal({
                key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                cwd: request.cwd,
                projectName: request.projectName,
                sessionId: request.sessionId,
                sessionTitle: request.sessionTitle,
                kind: request.kind,
                mode
              })
            }}
          >
            开始对话
          </button>
        </div>
      </div>
    </div>
  )
}
