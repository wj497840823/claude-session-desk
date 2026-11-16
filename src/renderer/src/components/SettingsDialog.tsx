import { useEffect, useState } from 'react'
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppTheme,
  type SessionClickAction,
  type TerminalPermissionMode
} from '@shared/types'
import { loadSnapshot } from '../lib/actions'
import { useStore } from '../store'
import { useDialog } from '../lib/useDialog'

const THEME_OPTIONS: Array<{ value: AppTheme; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

const PERMISSION_OPTIONS: Array<{
  value: TerminalPermissionMode
  label: string
}> = [
  { value: 'follow', label: '跟随 Claude 设置' },
  { value: 'manual', label: 'manual — 逐次询问' },
  { value: 'auto', label: 'auto — 自动判断' },
  { value: 'acceptEdits', label: 'acceptEdits — 自动接受编辑' },
  { value: 'plan', label: 'plan — 计划模式' },
  { value: 'dontAsk', label: 'dontAsk — 不询问' }
]

const SESSION_CLICK_OPTIONS: Array<{
  value: SessionClickAction
  label: string
}> = [
  { value: 'continue', label: '直接继续对话' },
  { value: 'record', label: '先查看会话记录' }
]

export default function SettingsDialog(): React.JSX.Element | null {
  const open = useStore((state) => state.settingsOpen)
  const snapshot = useStore((state) => state.snapshot)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const showToast = useStore((state) => state.showToast)
  const [draft, setDraft] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [saving, setSaving] = useState(false)
  const refreshing = useStore((state) => state.refreshing)
  const dialogRef = useDialog(open, () => setSettingsOpen(false))

  useEffect(() => {
    if (open) setDraft(useStore.getState().snapshot?.settings ?? DEFAULT_APP_SETTINGS)
  }, [open])

  if (!open) return null

  const update = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.updateSettings(draft)
      setSettingsOpen(false)
      if (await loadSnapshot(true)) showToast({ kind: 'success', message: '设置已保存' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `保存设置失败：${
          error instanceof Error ? error.message : String(error)
        }`
      })
    } finally {
      setSaving(false)
    }
  }

  const rescan = async (): Promise<void> => {
    try {
      if (await loadSnapshot(true)) showToast({ kind: 'success', message: '已重新扫描会话目录' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `重新扫描失败：${
          error instanceof Error ? error.message : String(error)
        }`
      })
    }
  }

  return (
    <div className="overlay" onMouseDown={() => setSettingsOpen(false)}>
      <div
        className="dialog settings-dialog"
        ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>设置</h2>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.loadHistory}
            onChange={(event) => update('loadHistory', event.target.checked)}
          />
          <span>
            <strong>加载历史记录</strong>
            <small>
              默认关闭。关闭时不读取 ~/.claude/history.jsonl，也不显示历史记录区和历史搜索结果；开启后才加载。
            </small>
          </span>
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.minimizeToTray}
            onChange={(event) =>
              update('minimizeToTray', event.target.checked)
            }
          />
          <span>
            <strong>关闭窗口时隐藏到托盘</strong>
            <small>
              开启后，点窗口的 × 会隐藏到系统托盘，Claude 对话继续运行。最小化仍保留任务栏图标；需要从托盘菜单退出。
            </small>
          </span>
        </label>

        <label className="settings-field">
          <span>主题</span>
          <select
            value={draft.theme}
            onChange={(event) => update('theme', event.target.value as AppTheme)}
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>点击活动会话时</span>
          <select
            value={draft.sessionClickAction}
            onChange={(event) =>
              update(
                'sessionClickAction',
                event.target.value as SessionClickAction
              )
            }
          >
            {SESSION_CLICK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>新建对话的默认权限模式</span>
          <select
            value={draft.defaultPermissionMode}
            onChange={(event) =>
              update(
                'defaultPermissionMode',
                event.target.value as TerminalPermissionMode
              )
            }
          >
            {PERMISSION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>终端字号</span>
          <select
            value={draft.terminalFontSize}
            onChange={(event) =>
              update('terminalFontSize', Number(event.target.value))
            }
          >
            {[11, 12, 13, 14, 15, 16, 18, 20].map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
        </label>

        <div className="settings-field">
          <span>Claude 数据目录</span>
          <div className="settings-path">{snapshot?.dataRoot ?? '未知'}</div>
          <button
            className="btn"
            style={{ alignSelf: 'flex-start', marginTop: 6 }}
            disabled={refreshing || saving}
            onClick={() => void rescan()}
          >
            重新扫描
          </button>
        </div>

        <p className="dialog-hint">
          历史记录设置只影响本应用是否加载和展示，不会删除 Claude 的
          history.jsonl。
        </p>

        <div className="dialog-actions">
          <button className="btn" onClick={() => setSettingsOpen(false)}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
