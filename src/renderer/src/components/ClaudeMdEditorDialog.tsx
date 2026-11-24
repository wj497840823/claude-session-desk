import { useEffect, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import type {
  ClaudeMdFileInfo,
  ClaudeMdLocationInfo,
  ClaudeMdPlacement,
  ClaudeMdScope,
  ClaudeMdTemplate
} from '@shared/types'
import { mergeClaudeMd } from '@shared/claudeMd'
import { useStore, type ClaudeMdEditorRequest } from '../store'
import { useDialog } from '../lib/useDialog'
import ConfirmDialog from './ConfirmDialog'

function nextScopedTemplateId(
  templates: ClaudeMdTemplate[],
  scope: ClaudeMdScope,
  current: string
): string {
  const scoped = templates.filter((template) => template.scope === scope)
  if (current && scoped.some((template) => template.id === current)) return current
  return scoped[0]?.id ?? ''
}

export default function ClaudeMdEditorDialog(): React.JSX.Element | null {
  const request = useStore((state) => state.claudeMdEditor)
  if (!request) return null
  return (
    <ClaudeMdEditor
      key={`${request.scope}:${request.projectKey ?? ''}`}
      request={request}
    />
  )
}

function ClaudeMdEditor({ request }: { request: ClaudeMdEditorRequest }): React.JSX.Element {
  const close = useStore((state) => state.closeClaudeMdEditor)
  const setTemplateManagerOpen = useStore((state) => state.setTemplateManagerOpen)
  const templateManagerOpen = useStore((state) => state.templateManagerOpen)
  const showToast = useStore((state) => state.showToast)

  const [info, setInfo] = useState<ClaudeMdFileInfo | null>(null)
  const [templates, setTemplates] = useState<ClaudeMdTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  const [original, setOriginal] = useState('')
  const [buffer, setBuffer] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [readError, setReadError] = useState('')
  const [templateError, setTemplateError] = useState('')
  const [status, setStatus] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [placement, setPlacement] = useState<ClaudeMdPlacement>('root')
  const [locations, setLocations] = useState<ClaudeMdLocationInfo[]>([])
  const [pendingPlacement, setPendingPlacement] = useState<ClaudeMdPlacement | null>(null)
  const [confirmReplace, setConfirmReplace] = useState<ClaudeMdTemplate | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const managerWasOpen = useRef(false)
  const firstLoad = useRef(true)
  const loadId = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useDialog(true, () => requestCancel())

  const visibleTemplates = templates.filter((template) => template.scope === request.scope)
  const selectedTemplate = visibleTemplates.find((template) => template.id === templateId)
  const dirty = buffer !== original
  const bothExist = locations.length === 2 && locations.every((item) => item.exists)

  const loadTemplates = async (): Promise<void> => {
    const list = await window.api.listClaudeMdTemplates()
    setTemplates(list)
    setTemplateId((current) => nextScopedTemplateId(list, request.scope, current))
    setTemplateError('')
  }

  const readPlacement = async (target: ClaudeMdPlacement): Promise<void> => {
    const id = ++loadId.current
    setLoading(true)
    setPlacement(target)
    setInfo(null)
    setOriginal('')
    setBuffer('')
    setStatus('')
    setReadError('')
    setConfirmReplace(null)
    try {
      const file = await window.api.readClaudeMd(
        'project',
        request.projectKey,
        target
      )
      if (loadId.current !== id) return
      setInfo(file)
      setOriginal(file.content)
      setBuffer(file.content)
    } catch (error) {
      if (loadId.current !== id) return
      const message = error instanceof Error ? error.message : String(error)
      setReadError(message)
      setStatus(`读取失败：${message}`)
    } finally {
      if (loadId.current === id) setLoading(false)
    }
  }

  const requestPlacement = (target: ClaudeMdPlacement): void => {
    if (target === placement || loading || saving) return
    if (dirty) {
      setPendingPlacement(target)
      return
    }
    void readPlacement(target)
  }

  useEffect(() => {
    let cancelled = false
    const initial = firstLoad.current
    firstLoad.current = false
    setLoading(true)
    setInfo(null)
    setOriginal('')
    setBuffer('')
    setStatus('')
    setReadError('')
    setTemplateError('')
    setTemplateId('')
    setConfirmReplace(null)
    setConfirmDiscard(false)
    setPendingPlacement(null)

    const read = async (target: ClaudeMdPlacement | undefined): Promise<void> => {
      const id = ++loadId.current
      if (target) setPlacement(target)
      try {
        const file = await window.api.readClaudeMd(
          request.scope,
          request.projectKey,
          target
        )
        if (cancelled || loadId.current !== id) return
        setInfo(file)
        setOriginal(file.content)
        setBuffer(file.content)
      } catch (error) {
        if (cancelled || loadId.current !== id) return
        const message = error instanceof Error ? error.message : String(error)
        setReadError(message)
        setStatus(`读取失败：${message}`)
      } finally {
        if (!cancelled && loadId.current === id) setLoading(false)
      }
    }

    const load = async (): Promise<void> => {
      if (request.scope !== 'project') {
        setLocations([])
        await read(undefined)
        return
      }
      if (!initial) {
        void window.api.getClaudeMdLocations('project', request.projectKey)
          .then((list) => {
            if (!cancelled) setLocations(list)
          })
          .catch(() => undefined)
        await read(placement)
        return
      }
      try {
        const list = await window.api.getClaudeMdLocations(
          'project',
          request.projectKey
        )
        if (cancelled) return
        setLocations(list)
        const root = list.find((item) => item.placement === 'root')
        const claude = list.find((item) => item.placement === 'claude-dir')
        const target: ClaudeMdPlacement = root?.exists
          ? 'root'
          : claude?.exists
            ? 'claude-dir'
            : 'root'
        await read(target)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setReadError(message)
        setStatus(`读取失败：${message}`)
        setLoading(false)
      }
    }

    void load()

    void window.api.listClaudeMdTemplates()
      .then((list) => {
        if (cancelled) return
        setTemplates(list)
        setTemplateId(nextScopedTemplateId(list, request.scope, ''))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setTemplateError(
          `读取模板失败：${error instanceof Error ? error.message : String(error)}`
        )
      })

    return () => {
      cancelled = true
      loadId.current += 1
    }
  }, [request, reloadToken])

  useEffect(() => {
    if (managerWasOpen.current && !templateManagerOpen) {
      void loadTemplates().catch((error: unknown) => {
        setTemplateError(
          `刷新模板失败：${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
    managerWasOpen.current = templateManagerOpen
  }, [templateManagerOpen])

  useEffect(() => {
    if (!loading && !readError) textareaRef.current?.focus()
  }, [loading, readError])

  function requestCancel(): void {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else close()
  }

  const applyReplace = (): void => {
    if (!selectedTemplate || loading || saving || readError) return
    if (buffer.trim() && dirty) {
      setConfirmReplace(selectedTemplate)
      return
    }
    setBuffer(selectedTemplate.content)
    setStatus(`已应用「${selectedTemplate.name}」全文，尚未保存`)
  }

  const applyMerge = (): void => {
    if (!selectedTemplate || loading || saving || readError) return
    const result = mergeClaudeMd(buffer, selectedTemplate.content)
    if (result.added.length === 0) {
      setStatus('模板内容已全部存在，未做修改')
      return
    }
    setBuffer(result.content)
    setStatus(
      `已追加 ${result.added.length} 个小节，跳过 ${result.skipped.length} 个已存在小节`
    )
  }

  const save = async (): Promise<void> => {
    if (saving || loading || readError) return
    setSaving(true)
    try {
      const result = await window.api.writeClaudeMd({
        scope: request.scope,
        projectKey: request.projectKey,
        placement: request.scope === 'project' ? placement : undefined,
        content: buffer
      })
      if (!result.ok) throw new Error(result.message ?? '保存失败')
      setOriginal(buffer)
      close()
      const message = result.created
        ? `已创建：${result.path}`
        : `已保存：${result.path}${result.backupPath ? `；备份：${result.backupPath}` : ''}`
      showToast({ kind: 'success', message })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `保存失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setSaving(false)
    }
  }

  const title = request.scope === 'global'
    ? '编辑全局 CLAUDE.md'
    : `编辑「${request.projectName ?? '项目'}」的 CLAUDE.md`

  return (
    <>
      <div className="overlay" onMouseDown={requestCancel}>
        <div
          className="dialog claude-md-dialog"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              if (!saving && !loading && !readError && dirty) void save()
            }
          }}
        >
          <h2>{title}</h2>

          <div className="claude-md-meta">
            <div className="settings-path">{info?.path ?? '读取中…'}</div>
            <span className="dialog-hint">
              {info ? (info.exists ? '已存在' : '尚未创建，保存后将新建') : ''}
              {dirty ? ' · 有未保存的修改' : ''}
            </span>
          </div>

          {bothExist && (
            <p className="dialog-hint">
              项目根目录和 .claude 文件夹下都存在 CLAUDE.md，建议只保留一处，避免同一项目维护两份指令。
            </p>
          )}

          <div className="claude-md-toolbar">
            {request.scope === 'project' && (
              <label className="settings-field">
                <span>位置</span>
                <select
                  value={placement}
                  disabled={loading || saving}
                  onChange={(event) =>
                    requestPlacement(event.target.value as ClaudeMdPlacement)
                  }
                >
                  <option value="root">项目根目录（CLAUDE.md）</option>
                  <option value="claude-dir">.claude 文件夹（.claude/CLAUDE.md）</option>
                </select>
              </label>
            )}
            <label className="settings-field">
              <span>模板</span>
              <select
                value={templateId}
                disabled={loading || saving || Boolean(readError)}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                {visibleTemplates.length === 0 && <option value="">没有可用模板</option>}
                {visibleTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}{template.builtin ? '（内置）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              disabled={!selectedTemplate || loading || saving || Boolean(readError)}
              onClick={applyReplace}
            >
              全量替换
            </button>
            <button
              className="btn"
              disabled={!selectedTemplate || loading || saving || Boolean(readError)}
              onClick={applyMerge}
            >
              增量添加
            </button>
            <button
              className="btn"
              disabled={saving}
              onClick={() => setTemplateManagerOpen(true, request.scope)}
            >
              <Settings2 size={13} /> 管理模板…
            </button>
          </div>

          {selectedTemplate?.description && (
            <p className="dialog-hint">{selectedTemplate.description}</p>
          )}
          {templateError && <p className="dialog-hint dialog-warning">{templateError}</p>}

          <textarea
            ref={textareaRef}
            className="claude-md-editor"
            aria-label="CLAUDE.md 内容"
            value={buffer}
            disabled={loading || Boolean(readError)}
            readOnly={saving}
            spellCheck={false}
            onChange={(event) => setBuffer(event.target.value)}
          />

          {readError ? (
            <div className="claude-md-status dialog-warning" role="alert">
              读取失败：{readError}
              <button
                className="btn"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                重试读取
              </button>
            </div>
          ) : status ? (
            <p className="claude-md-status" role="status" aria-live="polite">{status}</p>
          ) : null}

          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={requestCancel}>取消</button>
            <button
              className="btn primary"
              disabled={loading || saving || Boolean(readError) || !dirty}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存 (Ctrl+S)'}
            </button>
          </div>
        </div>
      </div>

      {confirmReplace && (
        <ConfirmDialog
          title="全量替换编辑区内容"
          confirmLabel="替换"
          message={
            <p>
              将用模板「{confirmReplace.name}」的全文替换当前编辑区内容（尚未写入文件）。
            </p>
          }
          onCancel={() => setConfirmReplace(null)}
          onConfirm={() => {
            setBuffer(confirmReplace.content)
            setStatus(`已应用「${confirmReplace.name}」全文，尚未保存`)
            setConfirmReplace(null)
          }}
        />
      )}

      {pendingPlacement && (
        <ConfirmDialog
          title="切换 CLAUDE.md 位置"
          confirmLabel="切换"
          message={
            <p>
              切换到「
              {pendingPlacement === 'root' ? '项目根目录' : '.claude 文件夹'}
              」将放弃当前未保存的修改。
            </p>
          }
          onCancel={() => setPendingPlacement(null)}
          onConfirm={() => {
            const target = pendingPlacement
            setPendingPlacement(null)
            if (target) void readPlacement(target)
          }}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="放弃未保存的修改"
          confirmLabel="放弃"
          danger
          message={<p>当前编辑内容尚未保存，确定关闭吗？</p>}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false)
            close()
          }}
        />
      )}
    </>
  )
}