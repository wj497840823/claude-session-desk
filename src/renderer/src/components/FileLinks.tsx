import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { FileContext } from '@shared/types'
import { findFileReferences } from '@shared/fileReferences'
import { useStore } from '../store'
import { checkFileReference } from '../lib/fileReferenceChecks'

export async function openFileReference(context: FileContext, reference: string, action: 'open' | 'reveal' = 'open'): Promise<void> {
  try {
    const result = await window.api.fileAction(context, reference, action)
    if (!result.ok || result.message) useStore.getState().showToast({
      kind: result.ok ? 'success' : 'error', message: result.message ?? '文件操作失败'
    })
  } catch (error) {
    useStore.getState().showToast({ kind: 'error', message: `文件操作失败：${String(error)}` })
  }
}

export interface FileMenuTarget { reference: string; x: number; y: number }

export function FileReferenceMenu({ context, target, onClose }: {
  context: FileContext; target: FileMenuTarget | null; onClose: () => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!target) return undefined
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) closeRef.current()
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeRef.current() }
    const blur = (): void => closeRef.current()
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); window.removeEventListener('blur', blur) }
  }, [target])
  if (!target) return null
  const perform = (action: 'open' | 'reveal'): void => {
    onClose()
    void openFileReference(context, target.reference, action)
  }
  return createPortal(<div className="menu file-reference-menu" role="menu" ref={ref}
    style={{ left: Math.max(4, Math.min(target.x, window.innerWidth - 200)), top: Math.max(4, Math.min(target.y, window.innerHeight - 125)) }}>
    <button role="menuitem" onClick={() => perform('open')}>打开文件</button>
    <button role="menuitem" onClick={() => perform('reveal')}>在文件夹中定位</button>
    <button role="menuitem" onClick={() => {
      onClose()
      void window.api.fileAction(context, target.reference, 'check').then(async (result) => {
        if (!result.ok || !result.path) throw new Error(result.message ?? '无法解析文件路径')
        await navigator.clipboard.writeText(result.path)
        useStore.getState().showToast({ kind: 'success', message: '已复制文件路径' })
      }).catch((error: unknown) => useStore.getState().showToast({ kind: 'error', message: String(error) }))
    }}>复制路径</button>
  </div>, document.body)
}

export function FileLink({ context, reference, children }: {
  context: FileContext; reference: string; children?: ReactNode
}): React.JSX.Element {
  const [menu, setMenu] = useState<FileMenuTarget | null>(null)
  const [checked, setChecked] = useState<{ source: string; path?: string; message?: string } | null>(null)
  const revision = useStore((state) => state.snapshot?.scannedAt)
  const web = /^https?:\/\//i.test(reference)
  useEffect(() => {
    let cancelled = false
    setChecked(null)
    if (!web && reference) void checkFileReference(context, reference).then((result) => {
      if (!cancelled) setChecked({ source: reference, path: result.ok ? result.path : undefined, message: result.message })
    })
    return () => { cancelled = true }
  }, [context.sessionKey, context.sessionId, reference, web, revision])
  if (/^https?:\/\//i.test(reference)) return <a href={reference} title={reference}
    onClick={(event) => { event.preventDefault(); void openFileReference(context, reference) }}>{children ?? reference}</a>
  const resolved = checked?.source === reference ? checked.path : undefined
  if (!resolved) return <span title={checked?.source === reference ? checked.message : undefined}>{children ?? reference}</span>
  return <>
    <a className="local-file-link" href="#" title={`${resolved}\n单击打开，Shift+单击定位；右键更多操作`}
      data-file-reference={resolved}
      onClick={(event) => { event.preventDefault(); void openFileReference(context, resolved, event.shiftKey ? 'reveal' : 'open') }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ reference: resolved, x: event.clientX, y: event.clientY }) }}>
      {children ?? reference}
    </a>
    <FileReferenceMenu context={context} target={menu} onClose={() => setMenu(null)} />
  </>
}

export function FileText({ context, text }: { context: FileContext; text: string }): React.JSX.Element {
  const references = findFileReferences(text)
  const parts: ReactNode[] = []
  let start = 0
  for (const item of references) {
    parts.push(text.slice(start, item.start))
    parts.push(<FileLink key={item.start} context={context} reference={item.reference}>{text.slice(item.start, item.end)}</FileLink>)
    start = item.end
  }
  parts.push(text.slice(start))
  return <>{parts}</>
}

export function fileTextChildren(context: FileContext, children: ReactNode): ReactNode {
  if (typeof children === 'string') return <FileText context={context} text={children} />
  if (Array.isArray(children)) return children.map((child, i) => typeof child === 'string'
    ? <FileText key={i} context={context} text={child} /> : child)
  return children
}
