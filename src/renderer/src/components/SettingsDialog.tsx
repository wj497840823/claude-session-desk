import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppTheme,
  type ClaudeMdFileInfo,
  type ClaudeMdTemplate,
  type LocalApiInfo,
  type SessionClickAction,
  type TerminalPermissionMode
} from '@shared/types'
import { mergeClaudeMd } from '@shared/claudeMd'
import { loadSnapshot } from '../lib/actions'
import { useStore } from '../store'
import { useDialog } from '../lib/useDialog'
import ConfirmDialog from './ConfirmDialog'

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

interface ClaudeMdApplyPlan {
  needsConfirm: boolean
  content: string
  added: number
  skipped: number
  noop: boolean
}

function planClaudeMdApply(
  current: ClaudeMdFileInfo,
  template: ClaudeMdTemplate,
  mode: 'replace' | 'merge'
): ClaudeMdApplyPlan {
  if (mode === 'replace') {
    return {
      needsConfirm: current.exists && current.content.trim().length > 0,
      content: template.content,
      added: 0,
      skipped: 0,
      noop: false
    }
  }
  const merged = mergeClaudeMd(current.content, template.content)
  return {
    needsConfirm: false,
    content: merged.content,
    added: merged.added.length,
    skipped: merged.skipped.length,
    noop: current.content.trim().length > 0 && merged.added.length === 0
  }
}

export default function SettingsDialog(): React.JSX.Element | null {
  const open = useStore((state) => state.settingsOpen)
  const snapshot = useStore((state) => state.snapshot)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const showToast = useStore((state) => state.showToast)
  const [draft, setDraft] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [localApi, setLocalApi] = useState<LocalApiInfo | null>(null)
  const refreshing = useStore((state) => state.refreshing)
  const dialogRef = useDialog(open, () => closeSettings())
  const openClaudeMdEditor = useStore((state) => state.openClaudeMdEditor)
  const setTemplateManagerOpen = useStore((state) => state.setTemplateManagerOpen)
  const templateManagerOpen = useStore((state) => state.templateManagerOpen)
  const claudeMdEditor = useStore((state) => state.claudeMdEditor)
  const [claudeMd, setClaudeMd] = useState<ClaudeMdFileInfo | null>(null)
  const [claudeMdTemplates, setClaudeMdTemplates] = useState<ClaudeMdTemplate[]>([])
  const [claudeMdTemplateId, setClaudeMdTemplateId] = useState('')
  const [claudeMdMode, setClaudeMdMode] = useState<'replace' | 'merge'>('replace')
  const [claudeMdBusy, setClaudeMdBusy] = useState(false)
  const [claudeMdTemplatesLoading, setClaudeMdTemplatesLoading] = useState(false)
  const [claudeMdLoading, setClaudeMdLoading] = useState(false)
  const [claudeMdError, setClaudeMdError] = useState('')
  const [claudeMdTemplateError, setClaudeMdTemplateError] = useState('')
  const [claudeMdStatus, setClaudeMdStatus] = useState('')
  const [claudeMdReload, setClaudeMdReload] = useState(0)
  const [confirmApply, setConfirmApply] = useState<{
    template: ClaudeMdTemplate
    mode: 'replace' | 'merge'
  } | null>(null)
  const claudeMdManagerWasOpen = useRef(false)
  const claudeMdEditorWasOpen = useRef(false)
  const claudeMdLoadId = useRef(0)
  const claudeMdTemplateLoadId = useRef(0)

  useEffect(() => {
    if (open) setDraft(useStore.getState().snapshot?.settings ?? DEFAULT_APP_SETTINGS)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const fileId = ++claudeMdLoadId.current
    const templateId = ++claudeMdTemplateLoadId.current
    let cancelled = false
    setClaudeMdLoading(true)
    setClaudeMdTemplatesLoading(true)
    setClaudeMdTemplates([])
    setClaudeMd(null)
    setClaudeMdError('')
    setClaudeMdTemplateError('')
    setClaudeMdStatus('')
    setConfirmApply(null)

    void window.api.readClaudeMd('global')
      .then((info) => {
        if (!cancelled && claudeMdLoadId.current === fileId) setClaudeMd(info)
      })
      .catch((error: unknown) => {
        if (!cancelled && claudeMdLoadId.current === fileId) {
          setClaudeMdError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled && claudeMdLoadId.current === fileId) setClaudeMdLoading(false)
      })

    void window.api.listClaudeMdTemplates()
      .then((list) => {
        if (cancelled || claudeMdTemplateLoadId.current !== templateId) return
        const globals = list.filter((template) => template.scope === 'global')
        setClaudeMdTemplates(globals)
        setClaudeMdTemplateId((current) =>
          current && globals.some((template) => template.id === current)
            ? current
            : globals[0]?.id ?? ''
        )
        setClaudeMdTemplateError('')
      })
      .catch((error: unknown) => {
        if (!cancelled && claudeMdTemplateLoadId.current === templateId) {
          setClaudeMdTemplateError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled && claudeMdTemplateLoadId.current === templateId) {
          setClaudeMdTemplatesLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, claudeMdReload])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.getLocalApiInfo().then((info) => {
      if (!cancelled) setLocalApi(info)
    }).catch(() => {
      if (!cancelled) setLocalApi(null)
    })
    return () => { cancelled = true }
  }, [open, snapshot?.settings.localApiEnabled])

  useEffect(() => {
    if (!open) return
    if (claudeMdManagerWasOpen.current && !templateManagerOpen) {
      const id = ++claudeMdTemplateLoadId.current
      setClaudeMdTemplatesLoading(true)
      void window.api.listClaudeMdTemplates()
        .then((list) => {
          if (claudeMdTemplateLoadId.current !== id) return
          const globals = list.filter((template) => template.scope === 'global')
          setClaudeMdTemplates(globals)
          setClaudeMdTemplateId((current) =>
            current && globals.some((template) => template.id === current)
              ? current
              : globals[0]?.id ?? ''
          )
          setClaudeMdTemplateError('')
        })
        .catch((error: unknown) => {
          if (claudeMdTemplateLoadId.current === id) {
            setClaudeMdTemplateError(error instanceof Error ? error.message : String(error))
          }
        })
        .finally(() => {
          if (claudeMdTemplateLoadId.current === id) {
            setClaudeMdTemplatesLoading(false)
          }
        })
    }
    claudeMdManagerWasOpen.current = templateManagerOpen
  }, [templateManagerOpen, open])

  useEffect(() => {
    if (claudeMdEditorWasOpen.current && !claudeMdEditor) {
      setClaudeMdReload((value) => value + 1)
    }
    claudeMdEditorWasOpen.current = Boolean(claudeMdEditor)
  }, [claudeMdEditor])

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

  function closeSettings(): void {
    if (!claudeMdBusy) setSettingsOpen(false)
  }

  const selectedGlobalTemplate =
    claudeMdTemplates.find((template) => template.id === claudeMdTemplateId) ?? null

  const writeGlobalTemplate = async (
    template: ClaudeMdTemplate,
    mode: 'replace' | 'merge',
    confirmed = false
  ): Promise<void> => {
    if (claudeMdBusy) return
    setClaudeMdBusy(true)
    try {
      const current = await window.api.readClaudeMd('global')
      setClaudeMd(current)
      setClaudeMdError('')
      const plan = planClaudeMdApply(current, template, mode)
      if (plan.needsConfirm && !confirmed) {
        setConfirmApply({ template, mode })
        return
      }
      if (plan.noop) {
        setClaudeMdStatus('模板内容已全部存在，未做修改')
        return
      }

      const result = await window.api.writeClaudeMd({
        scope: 'global',
        content: plan.content
      })
      if (!result.ok) throw new Error(result.message ?? '保存失败')
      setClaudeMd({
        scope: 'global',
        path: result.path,
        exists: true,
        content: plan.content
      })
      setClaudeMdError('')
      setClaudeMdStatus(
        result.changed
          ? mode === 'merge'
            ? `已追加 ${plan.added} 个小节，跳过 ${plan.skipped} 个已存在小节`
            : `已应用「${template.name}」全文`
          : '文件内容没有变化'
      )
      if (result.changed) {
        showToast({
          kind: 'success',
          message: result.created
            ? `已创建：${result.path}`
            : `已保存：${result.path}${result.backupPath ? `；备份：${result.backupPath}` : ''}`
        })
      } else {
        showToast({ kind: 'success', message: result.message ?? '文件内容没有变化' })
      }
    } catch (error) {
      setClaudeMdStatus('')
      showToast({
        kind: 'error',
        message: `应用模板失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setClaudeMdBusy(false)
    }
  }

  const applyGlobalTemplate = (): void => {
    if (
      !selectedGlobalTemplate ||
      claudeMdBusy ||
      claudeMdLoading ||
      Boolean(claudeMdError) ||
      claudeMdTemplatesLoading ||
      Boolean(claudeMdTemplateError)
    ) return
    void writeGlobalTemplate(selectedGlobalTemplate, claudeMdMode)
  }

  return (
    <>
      <div className="overlay" onMouseDown={() => closeSettings()}>
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

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.desktopNotifications}
            onChange={(event) =>
              update('desktopNotifications', event.target.checked)
            }
          />
          <span>
            <strong>对话需要你时发送系统通知</strong>
            <small>
              窗口不在前台时，Claude 完成回复或等待审批会发送 Windows 通知；点击通知可回到对应对话。
            </small>
          </span>
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.localApiEnabled}
            onChange={(event) =>
              update('localApiEnabled', event.target.checked)
            }
          />
          <span>
            <strong>启用本地 HTTP 接口</strong>
            <small>
              只监听 127.0.0.1，使用 Bearer Token。保存后可用于脚本查询状态、运行/暂停任务、回答审批与提问，以及提交外部事件。
            </small>
          </span>
        </label>

        {draft.localApiEnabled && (
          <div className="settings-field local-api-info">
            <span>接口地址</span>
            <input
              readOnly
              value={localApi?.url ?? (localApi?.enabled ? '启动失败，请重新保存设置' : '保存后启动')}
            />
            {localApi?.token && (
              <>
                <span>Bearer Token</span>
                <div className="scheduled-path-row">
                  <input readOnly value={localApi.token} />
                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(localApi.token!)
                        .then(() => showToast({ kind: 'success', message: 'Token 已复制' }))
                        .catch(() => showToast({ kind: 'error', message: '复制失败' }))
                    }}
                  >
                    复制
                  </button>
                </div>
              </>
            )}
            <small className="dialog-hint">
              示例：curl -H "Authorization: Bearer &lt;token&gt;" {localApi?.url ?? 'http://127.0.0.1:端口'}/v1/status
            </small>
          </div>
        )}

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.terminalCopyOnSelect}
            onChange={(event) =>
              update('terminalCopyOnSelect', event.target.checked)
            }
          />
          <span>
            <strong>选中终端文本时自动复制</strong>
            <small>
              用鼠标或键盘选中终端内容后自动写入剪贴板，不需要再按 Ctrl+Shift+C。
            </small>
          </span>
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.terminalRightClickPaste}
            onChange={(event) =>
              update('terminalRightClickPaste', event.target.checked)
            }
          />
          <span>
            <strong>在终端中右键粘贴</strong>
            <small>
              在终端空白处右键粘贴剪贴板内容；右键文件路径时仍打开文件操作菜单。
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

        <div className="claude-md-settings">
          <span>CLAUDE.md 全局规则</span>
          <div className="settings-path">
            {claudeMd?.path ?? (claudeMdLoading ? '读取中…' : '未知')}
          </div>
          <small className="dialog-hint" role="status" aria-live="polite">
            {claudeMdError
              ? <span className="dialog-warning">读取失败：{claudeMdError}</span>
              : claudeMd?.exists
                ? '已存在'
                : '尚未创建，应用模板后将创建'}
            {claudeMdStatus ? ` · ${claudeMdStatus}` : ''}
          </small>
          {claudeMdError && (
            <button
              className="btn"
              onClick={() => setClaudeMdReload((value) => value + 1)}
            >
              重试读取
            </button>
          )}

          <label className="settings-field" style={{ marginTop: 6 }}>
            <span>模板</span>
            <select
              value={claudeMdTemplateId}
              disabled={claudeMdBusy || claudeMdLoading || Boolean(claudeMdError) || claudeMdTemplatesLoading || Boolean(claudeMdTemplateError)}
              onChange={(event) => setClaudeMdTemplateId(event.target.value)}
            >
              {claudeMdTemplates.length === 0 && <option value="">没有可用模板</option>}
              {claudeMdTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}{template.builtin ? '（内置）' : ''}
                </option>
              ))}
            </select>
          </label>
          {claudeMdTemplateError && (
            <>
              <small className="dialog-hint dialog-warning">
                读取模板失败：{claudeMdTemplateError}
              </small>
              <button
                className="btn"
                onClick={() => setClaudeMdReload((value) => value + 1)}
              >
                重试读取模板
              </button>
            </>
          )}

          <div className="claude-md-mode">
            <label>
              <input
                type="radio"
                name="claude-md-mode"
                checked={claudeMdMode === 'replace'}
                disabled={claudeMdBusy}
                onChange={() => setClaudeMdMode('replace')}
              />
              全量替换
            </label>
            <label>
              <input
                type="radio"
                name="claude-md-mode"
                checked={claudeMdMode === 'merge'}
                disabled={claudeMdBusy}
                onChange={() => setClaudeMdMode('merge')}
              />
              增量添加
            </label>
          </div>

          <div className="claude-md-actions">
            <button
              className="btn"
              disabled={
                !selectedGlobalTemplate ||
                claudeMdBusy ||
                claudeMdLoading ||
                Boolean(claudeMdError) ||
                claudeMdTemplatesLoading ||
                Boolean(claudeMdTemplateError)
              }
              onClick={applyGlobalTemplate}
            >
              {claudeMdBusy ? '应用中…' : '应用到文件'}
            </button>
            <button
              className="btn"
              disabled={claudeMdBusy}
              onClick={() => openClaudeMdEditor({ scope: 'global' })}
            >
              编辑全局 CLAUDE.md
            </button>
            <button
              className="btn"
              disabled={claudeMdBusy}
              onClick={() => setTemplateManagerOpen(true, 'global')}
            >
              管理模板…
            </button>
          </div>
        </div>

        <p className="dialog-hint">
          历史记录设置只影响本应用是否加载和展示，不会删除 Claude 的
          history.jsonl。
        </p>

        <div className="dialog-actions">
          <button className="btn" disabled={saving || claudeMdBusy} onClick={closeSettings}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={saving || claudeMdBusy}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
      </div>

      {confirmApply && (
        <ConfirmDialog
          title="应用全局模板"
          confirmLabel="替换"
          message={
            <p>
              将用「{confirmApply.template.name}」全文替换现有的全局 CLAUDE.md，旧内容会自动备份。
            </p>
          }
          onCancel={() => setConfirmApply(null)}
          onConfirm={() => {
            const pending = confirmApply
            setConfirmApply(null)
            if (pending) void writeGlobalTemplate(pending.template, pending.mode, true)
          }}
        />
      )}
    </>
  )
}
