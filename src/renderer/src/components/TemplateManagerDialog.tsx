import { useEffect, useRef, useState } from 'react'
import { Download, Plus, Trash2 } from 'lucide-react'
import type { ClaudeMdScope, ClaudeMdTemplate } from '@shared/types'
import { useStore } from '../store'
import { useDialog } from '../lib/useDialog'
import ConfirmDialog from './ConfirmDialog'

interface TemplateForm {
  id?: string
  name: string
  scope: ClaudeMdScope
  description: string
  content: string
  builtin: boolean
}

type BusyKind = 'save' | 'delete' | 'import' | null

type TemplateAction =
  | { kind: 'select'; template: ClaudeMdTemplate }
  | { kind: 'new' }
  | { kind: 'import' }
  | { kind: 'close' }
  | { kind: 'tab'; tab: ClaudeMdScope }

const EMPTY_FORM: TemplateForm = {
  name: '',
  scope: 'global',
  description: '',
  content: '',
  builtin: false
}

function toForm(template: ClaudeMdTemplate): TemplateForm {
  return {
    id: template.id,
    name: template.name,
    scope: template.scope,
    description: template.description,
    content: template.content,
    builtin: template.builtin
  }
}

function sameForm(left: TemplateForm, right: TemplateForm): boolean {
  return left.id === right.id &&
    left.name === right.name &&
    left.scope === right.scope &&
    left.description === right.description &&
    left.content === right.content
}

export default function TemplateManagerDialog(): React.JSX.Element | null {
  const open = useStore((state) => state.templateManagerOpen)
  const initialScope = useStore((state) => state.templateManagerScope)
  const setOpen = useStore((state) => state.setTemplateManagerOpen)
  const showToast = useStore((state) => state.showToast)

  const [templates, setTemplates] = useState<ClaudeMdTemplate[]>([])
  const [tab, setTab] = useState<ClaudeMdScope>(initialScope)
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM)
  const [baseline, setBaseline] = useState<TemplateForm>(EMPTY_FORM)
  const [busy, setBusy] = useState<BusyKind>(null)
  const [pendingAction, setPendingAction] = useState<TemplateAction | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const generation = useRef(0)
  const dialogRef = useDialog(open, () => requestClose())

  const dirty = !form.builtin && !sameForm(form, baseline)
  const visible = templates.filter((template) => template.scope === tab)

  const refresh = async (
    preferredId?: string,
    id = generation.current
  ): Promise<boolean> => {
    const list = await window.api.listClaudeMdTemplates()
    if (generation.current !== id) return false
    setTemplates(list)
    const next = preferredId
      ? list.find((template) => template.id === preferredId)
      : undefined
    if (next) {
      const nextForm = toForm(next)
      setForm(nextForm)
      setBaseline(nextForm)
      setTab(next.scope)
    }
    return true
  }

  useEffect(() => {
    if (!open) return
    const id = ++generation.current
    const next = { ...EMPTY_FORM, scope: initialScope }
    setTab(initialScope)
    setForm(next)
    setBaseline(next)
    setBusy(null)
    setPendingAction(null)
    setConfirmDelete(false)
    void window.api.listClaudeMdTemplates()
      .then((list) => {
        if (generation.current === id) setTemplates(list)
      })
      .catch((error: unknown) => {
        if (generation.current !== id) return
        showToast({
          kind: 'error',
          message: `读取模板失败：${error instanceof Error ? error.message : String(error)}`
        })
      })
  }, [open, initialScope])

  if (!open) return null

  const update = <K extends keyof TemplateForm>(key: K, value: TemplateForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const runAction = (action: TemplateAction): void => {
    if (action.kind === 'select') {
      const next = toForm(action.template)
      setForm(next)
      setBaseline(next)
      setTab(action.template.scope)
      return
    }
    if (action.kind === 'new') {
      const next = { ...EMPTY_FORM, scope: tab }
      setForm(next)
      setBaseline(next)
      return
    }
    if (action.kind === 'import') {
      void importTemplate()
      return
    }
    if (action.kind === 'close') {
      setOpen(false)
      return
    }
    const next = { ...EMPTY_FORM, scope: action.tab }
    setTab(action.tab)
    setForm(next)
    setBaseline(next)
  }

  const requestAction = (action: TemplateAction): void => {
    if (busy) return
    if (dirty) {
      setPendingAction(action)
      return
    }
    runAction(action)
  }

  function requestClose(): void {
    requestAction({ kind: 'close' })
  }

  const duplicateBuiltin = (): void => {
    if (busy || !form.builtin) return
    const next = {
      ...form,
      id: undefined,
      name: `${form.name}（副本）`.slice(0, 60),
      builtin: false
    }
    setForm(next)
    setBaseline(next)
    setTab(next.scope)
  }

  const save = async (): Promise<void> => {
    if (busy || form.builtin || !form.name.trim()) return
    setBusy('save')
    const id = generation.current
    let saved: ClaudeMdTemplate
    try {
      saved = await window.api.saveClaudeMdTemplate({
        id: form.id,
        name: form.name,
        scope: form.scope,
        description: form.description,
        content: form.content
      })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `保存模板失败：${error instanceof Error ? error.message : String(error)}`
      })
      setBusy(null)
      return
    }

    const savedForm = toForm(saved)
    setForm(savedForm)
    setBaseline(savedForm)
    setTab(saved.scope)
    try {
      await refresh(saved.id, id)
      showToast({ kind: 'success', message: '模板已保存' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `已保存，但刷新模板列表失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy || !form.id || form.builtin) return
    setBusy('delete')
    try {
      await window.api.deleteClaudeMdTemplate(form.id)
    } catch (error) {
      showToast({
        kind: 'error',
        message: `删除模板失败：${error instanceof Error ? error.message : String(error)}`
      })
      setBusy(null)
      return
    }

    const scope = form.scope
    setTab(scope)
    const next = { ...EMPTY_FORM, scope }
    setForm(next)
    setBaseline(next)
    try {
      await refresh(undefined, generation.current)
      showToast({ kind: 'success', message: '模板已删除' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `已删除，但刷新模板列表失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(null)
    }
  }

  const importTemplate = async (): Promise<void> => {
    if (busy) return
    setBusy('import')
    try {
      const imported = await window.api.importClaudeMdTemplate(tab)
      if (!imported) return
      const importedForm = toForm(imported)
      setForm(importedForm)
      setBaseline(importedForm)
      setTab(imported.scope)
      try {
        await refresh(imported.id, generation.current)
        showToast({ kind: 'success', message: '模板已导入' })
      } catch (error) {
        showToast({
          kind: 'error',
          message: `已导入，但刷新模板列表失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
    } catch (error) {
      showToast({
        kind: 'error',
        message: `导入模板失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="overlay" onMouseDown={requestClose}>
        <div
          className="dialog template-manager"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="模板管理"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2>模板管理</h2>

          <div className="template-tabs" role="tablist" aria-label="模板作用域">
            <button
              className={`btn ${tab === 'global' ? 'primary' : ''}`}
              role="tab"
              aria-selected={tab === 'global'}
              disabled={Boolean(busy)}
              onClick={() => requestAction({ kind: 'tab', tab: 'global' })}
            >
              全局
            </button>
            <button
              className={`btn ${tab === 'project' ? 'primary' : ''}`}
              role="tab"
              aria-selected={tab === 'project'}
              disabled={Boolean(busy)}
              onClick={() => requestAction({ kind: 'tab', tab: 'project' })}
            >
              项目
            </button>
            <span style={{ flex: 1 }} />
            <button
              className="btn"
              disabled={Boolean(busy)}
              onClick={() => requestAction({ kind: 'new' })}
            >
              <Plus size={13} /> 新建
            </button>
            <button
              className="btn"
              disabled={Boolean(busy)}
              onClick={() => requestAction({ kind: 'import' })}
            >
              <Download size={13} /> 导入 .md
            </button>
          </div>

          <div className="template-manager-body">
            <div className="template-list">
              {visible.map((template) => (
                <button
                  key={template.id}
                  className={form.id === template.id ? 'active' : ''}
                  aria-pressed={form.id === template.id}
                  disabled={Boolean(busy)}
                  onClick={() => requestAction({ kind: 'select', template })}
                >
                  <span>{template.name}</span>
                  <small>{template.builtin ? '内置 · 只读' : '自定义'}</small>
                </button>
              ))}
              {visible.length === 0 && <div className="rail-empty">没有模板</div>}
            </div>

            <div className="template-editor">
              <label className="settings-field">
                <span>名称</span>
                <input
                  value={form.name}
                  maxLength={60}
                  disabled={form.builtin || Boolean(busy)}
                  onChange={(event) => update('name', event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>作用域</span>
                <select
                  value={form.scope}
                  disabled={form.builtin || Boolean(busy)}
                  onChange={(event) => update('scope', event.target.value as ClaudeMdScope)}
                >
                  <option value="global">全局</option>
                  <option value="project">项目</option>
                </select>
              </label>
              <label className="settings-field">
                <span>说明</span>
                <input
                  value={form.description}
                  maxLength={200}
                  disabled={form.builtin || Boolean(busy)}
                  onChange={(event) => update('description', event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>内容</span>
                <textarea
                  value={form.content}
                  disabled={form.builtin || Boolean(busy)}
                  spellCheck={false}
                  onChange={(event) => update('content', event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="dialog-actions">
            {form.builtin && (
              <button className="btn" disabled={Boolean(busy)} onClick={duplicateBuiltin}>
                复制为自定义
              </button>
            )}
            {!form.builtin && form.id && (
              <button
                className="btn danger"
                disabled={Boolean(busy)}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={13} /> 删除
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn" disabled={Boolean(busy)} onClick={requestClose}>
              关闭
            </button>
            <button
              className="btn primary"
              disabled={Boolean(busy) || form.builtin || !form.name.trim()}
              onClick={() => void save()}
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>

      {pendingAction && (
        <ConfirmDialog
          title="放弃未保存的修改"
          confirmLabel="放弃"
          danger
          message={<p>当前模板的修改尚未保存，确定继续吗？</p>}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction
            setPendingAction(null)
            if (action) runAction(action)
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="删除模板"
          confirmLabel="删除"
          danger
          message={<p>确定删除自定义模板「{form.name}」吗？此操作不可撤销。</p>}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void remove()
          }}
        />
      )}
    </>
  )
}