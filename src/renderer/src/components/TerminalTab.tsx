import { useEffect, useRef, useState } from 'react'
import {
  Download,
  FileText,
  FolderOpen,
  History,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Plug,
  Paperclip,
  ClipboardPaste as ClipboardIcon,
  RotateCcw,
  Sparkles,
  Square,
  X,
  Terminal as TerminalIcon,
  Trash2
} from 'lucide-react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Attachment, ClipboardPaste, SessionUsage, TerminalDataEvent, TerminalExitEvent, TerminalPermissionMode } from '@shared/types'
import {
  deleteSession,
  exportSession,
  resumeSession
} from '../lib/actions'
import { useStore, type TerminalSession } from '../store'
import { registerTerminalStopper } from '../lib/terminalControllers'
import ConfirmDialog from './ConfirmDialog'
import { FileLink, FileReferenceMenu, openFileReference, type FileMenuTarget } from './FileLinks'
import { registerTerminalFileLinks } from '../lib/terminalFileLinks'
import { addDraftFiles, emptyDraft, loadDraft, removeDraftFiles, saveDraft } from '../lib/attachmentDraft'
import { checkFileReference } from '../lib/fileReferenceChecks'
import { attachmentText } from '@shared/fileReferences'
import { formatCompactTokens, formatUsageCost } from '@shared/usage'

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  cursor: '#2563eb',
  selectionBackground: '#cfe3ff'
}

const DARK_THEME: ITheme = {
  background: '#17171a',
  foreground: '#f2f2f5',
  cursor: '#6ea0ff',
  selectionBackground: '#2f4a7a'
}

const MODE_LABELS: Record<TerminalPermissionMode, string> = {
  follow: '跟随 Claude 设置',
  manual: 'manual',
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  dontAsk: 'dontAsk'
}

type PendingAction = 'stop' | 'restart' | null

export default function TerminalTab({
  session,
  active
}: {
  session: TerminalSession
  active: boolean
}): React.JSX.Element {
  const setStatus = useStore((state) => state.setTerminalStatus)
  const clearTerminalActivity = useStore((state) => state.clearTerminalActivity)
  const setFocused = useStore((state) => state.setTerminalFocused)
  const showToast = useStore((state) => state.showToast)
  const snapshot = useStore((state) => state.snapshot)
  const selectSession = useStore((state) => state.selectSession)
  const closeTerminal = useStore((state) => state.closeTerminal)
  const fontSize = useStore(
    (state) => state.snapshot?.settings.terminalFontSize ?? 13
  )
  const themeSetting = useStore(
    (state) => state.snapshot?.settings.theme ?? 'system'
  )
  const activity = useStore((state) =>
    session.sessionId ? state.terminalActivity[session.sessionId] : undefined
  )
  const copyOnSelect = useStore(
    (state) => state.snapshot?.settings.terminalCopyOnSelect ?? true
  )
  const rightClickPaste = useStore(
    (state) => state.snapshot?.settings.terminalRightClickPaste ?? true
  )
  const copyOnSelectRef = useRef(copyOnSelect)
  const rightClickPasteRef = useRef(rightClickPaste)
  copyOnSelectRef.current = copyOnSelect
  rightClickPasteRef.current = rightClickPaste
  const sessionKey = snapshot?.sessions.find((item) =>
    item.source === 'transcript' && item.id === session.sessionId && item.projectPath === session.cwd
  )?.key ?? snapshot?.sessions.find((item) =>
    item.source === 'transcript' && item.id === session.sessionId
  )?.key ?? null
  const [usage, setUsage] = useState<SessionUsage | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const startRef = useRef<() => Promise<void>>(async () => undefined)
  const stopRef = useRef<() => void>(() => undefined)
  const restartRef = useRef<() => void>(() => undefined)
  const resizeRef = useRef<() => void>(() => undefined)
  const activeRef = useRef(active)
  const attachmentInputRef = useRef<{
    paste: (stage?: boolean) => Promise<void>; pick: () => Promise<void>; drop: (files: unknown[]) => Promise<void>
    remove: (ids: string[], clearDraft?: boolean) => Promise<void>; send: (submit: boolean) => Promise<void>
  }>({ paste: async () => undefined, pick: async () => undefined, drop: async () => undefined,
    remove: async () => undefined, send: async () => undefined })
  const hoveredFileRef = useRef<string | null>(null)
  const dragDepthRef = useRef(0)
  activeRef.current = active
  const themeSettingRef = useRef(themeSetting)
  themeSettingRef.current = themeSetting

  const [starting, setStarting] = useState(false)
  const [running, setRunning] = useState(false)
  const [pending, setPending] = useState<PendingAction>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [claudeMenuOpen, setClaudeMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const [draft, setDraft] = useState(() => loadDraft(session.sessionId))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const draftInputRef = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [launched, setLaunched] = useState(false)
  const [fileMenu, setFileMenu] = useState<FileMenuTarget | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const claudeMenuRef = useRef<HTMLDivElement>(null)

  const summary = snapshot?.sessions.find(
    (item) => item.id === session.sessionId && item.source === 'transcript'
  )

  useEffect(() => {
    if (!saveDraft(session.sessionId, draft)) showToast({ kind: 'error', message: '草稿暂时无法保存到本地，请保留当前标签' })
  }, [draft, session.sessionId, showToast])

  useEffect(() => {
    if (!menuOpen && !claudeMenuOpen) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || claudeMenuRef.current?.contains(target)) {
        return
      }
      setMenuOpen(false)
      setClaudeMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setClaudeMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen, claudeMenuOpen])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let disposed = false
    let startPending = false
    let restarting = false
    let hasLaunched = false
    let pendingAttachments = 0
    let sendingDraft = false
    let attachmentRevision = 0
    let writeQueue: Promise<void> = Promise.resolve()
    let bufferedSize = 0
    const pendingData: TerminalDataEvent[] = []
    const pendingExits = new Map<string, TerminalExitEvent>()
    const context = { sessionId: session.sessionId }
    const mergeAttachments = (items: Attachment[]): void => {
      if (disposed) return
      setAttachments((previous) => [...new Map([...previous, ...items].map((item) => [item.path, item])).values()])
    }
    const activateFile = (event: MouseEvent, text: string): void => {
      event.preventDefault()
      void openFileReference(context, text, event.shiftKey ? 'reveal' : 'open')
    }
    const hoverFile = (text: string | null): void => {
      hoveredFileRef.current = text
      container.title = text ? /^https?:\/\//i.test(text) ? `${text}\n单击在浏览器中打开` :
        `${text}\n单击打开，Shift+单击定位；右键更多操作` : ''
    }
    const initialDark =
      themeSetting === 'dark' ||
      (themeSetting === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      lineHeight: 1.2,
      scrollback: 10000,
      linkHandler: { allowNonHttpProtocols: true, activate: activateFile, hover: (_event, text) => hoverFile(text), leave: () => hoverFile(null) },
      theme: initialDark ? DARK_THEME : LIGHT_THEME
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(container)
    const checkFile = (reference: string) => checkFileReference(context, reference)
    const fileLinks = registerTerminalFileLinks(term, activateFile, hoverFile, checkFile)
    // Claude may emit native OSC 8 hyperlinks as well as colored text. Consume
    // invalid local openers so only real local targets become native links.
    const nativeFileLinks = term.parser.registerOscHandler(8, async (data) => {
      const divider = data.indexOf(';')
      if (divider < 0) return true
      const reference = data.slice(divider + 1)
      if (!reference || /^https?:\/\//i.test(reference)) return false
      const result = await checkFile(reference)
      return !result.ok || !result.path
    })
    let selectionTimer: ReturnType<typeof setTimeout> | null = null
    const selectionDisposable = term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return
      if (selectionTimer) clearTimeout(selectionTimer)
      selectionTimer = setTimeout(() => {
        selectionTimer = null
        if (disposed || !term.hasSelection()) return
        void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined)
      }, 250)
    })
    const insert = async (
      task: () => Promise<ClipboardPaste>,
      options: { stage?: boolean; notifyEmpty?: boolean } = {}
    ): Promise<void> => {
      const ptyId = ptyIdRef.current
      if (!ptyId || disposed) {
        showToast({ kind: 'error', message: '请等待 Claude 对话启动后再添加附件' })
        return
      }
      if (pendingAttachments || sendingDraft) return
      pendingAttachments += 1
      attachmentRevision += 1
      setAttaching(true)
      try {
        const result = await task()
        if (disposed) return
        if (ptyIdRef.current !== ptyId) throw new Error('对话已结束，请重新添加附件')
        if (result.attachments.length) {
          mergeAttachments(result.attachments)
          if (options.stage) {
            setDraft((previous) => addDraftFiles(previous, result.attachments))
            if (activeRef.current) requestAnimationFrame(() => draftInputRef.current?.focus())
          } else {
            // Copying a file or image inserts its reference immediately; the
            // attachment record stays removable without another confirmation.
            term.paste(attachmentText(result.attachments.map((file) => file.path)))
            if (activeRef.current) term.focus()
          }
        } else if (result.text) {
          if (draftRef.current.text || draftRef.current.files.length) setDraft((previous) => ({ ...previous, text: previous.text + result.text }))
          else term.paste(result.text)
        } else if (options.notifyEmpty) showToast({ kind: 'error', message: '剪贴板中没有可粘贴的文件、图片或文本' })
        if (activeRef.current && !result.attachments.length && !draftRef.current.text) term.focus()
      } catch (error) {
        if (!disposed) showToast({ kind: 'error', message: `添加或粘贴失败：${error instanceof Error ? error.message : String(error)}` })
      } finally {
        pendingAttachments -= 1
        if (!disposed) setAttaching(pendingAttachments > 0)
      }
    }
    attachmentInputRef.current = {
      paste: (stage = false) => insert(() => window.api.pasteClipboard(context), { notifyEmpty: true, stage }),
      pick: () => insert(async () => ({ attachments: await window.api.pickAttachments(context) }), { stage: true }),
      drop: (files) => insert(async () => ({ attachments: await window.api.attachDroppedFiles(context, files) }), { stage: true }),
      remove: async (ids, clearDraft = false) => {
        if (pendingAttachments || sendingDraft || disposed) return
        pendingAttachments += 1; setAttaching(true)
        attachmentRevision += 1
        try {
          const remaining = ids.length ? await window.api.removeAttachments(context, ids) : []
          if (disposed) return
          if (ids.length) setAttachments(remaining)
          setDraft((previous) => clearDraft ? emptyDraft() : removeDraftFiles(previous, ids))
        } catch (error) {
          if (!disposed) showToast({ kind: 'error', message: `移除失败，附件已保留，可重试：${String(error)}` })
        } finally { pendingAttachments -= 1; if (!disposed) setAttaching(false) }
      },
      send: async (submit) => {
        const value = draftRef.current
        const ptyId = ptyIdRef.current
        if (!ptyId || disposed || pendingAttachments || sendingDraft || !value.text.trim()) return
        sendingDraft = true; setSending(true)
        try {
          for (const file of value.files) {
            const result = await window.api.fileAction(context, file.path, 'check')
            if (!result.ok) throw new Error(`${file.name}：${result.message ?? '文件不可用'}`)
          }
          if (ptyIdRef.current !== ptyId || disposed) throw new Error('对话已结束，请重新启动后重试')
          term.paste(value.text)
          await writeQueue
          if (submit) {
            await new Promise((resolve) => window.setTimeout(resolve, 150))
            if (ptyIdRef.current !== ptyId || disposed) throw new Error('对话已结束，请检查终端输入')
            await window.api.writeTerminal(ptyId, '\r')
          }
          if (!disposed) { setDraft(emptyDraft()); if (activeRef.current) term.focus() }
        } catch (error) {
          if (!disposed) showToast({ kind: 'error', message: `未完成发送，草稿已保留，请检查终端输入后重试：${String(error)}` })
        } finally { sendingDraft = false; if (!disposed) setSending(false) }
      }
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (![...(event.clipboardData?.items ?? [])].some((item) => item.kind === 'file' || item.type.startsWith('image/') || item.type === 'text/uri-list')) return
      event.preventDefault()
      event.stopPropagation()
      void attachmentInputRef.current.paste()
    }
    container.addEventListener('paste', onPaste, true)
    const onAttachmentsAdded = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string; attachments?: Attachment[] }>).detail
      if (!detail || detail.sessionId !== session.sessionId || !detail.attachments?.length) return
      mergeAttachments(detail.attachments)
      const ptyId = ptyIdRef.current
      if (!ptyId) {
        showToast({ kind: 'error', message: '截图已保存，但对话已结束，请重新打开后再插入' })
        return
      }
      void window.api
        .writeTerminal(ptyId, attachmentText(detail.attachments.map((item) => item.path)))
        .catch((error: unknown) => {
          showToast({ kind: 'error', message: `写入截图路径失败：${String(error)}` })
        })
      if (activeRef.current) term.focus()
    }
    window.addEventListener('csm:attachments-added', onAttachmentsAdded)
    try {
      fit.fit()
    } catch {
      // container may not be laid out yet
    }

    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const onThemeChange = (): void => {
      const forced = themeSettingRef.current
      term.options.theme =
        forced === 'dark' || (forced === 'system' && darkQuery.matches)
          ? DARK_THEME
          : LIGHT_THEME
    }
    darkQuery.addEventListener('change', onThemeChange)

    const textarea = term.textarea

    const onFocus = (): void => setFocused(true)
    const onBlur = (): void => setFocused(false)
    textarea?.addEventListener('focus', onFocus, true)
    textarea?.addEventListener('blur', onBlur, true)

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      if (((event.ctrlKey || event.metaKey) && key === 'v') || (event.shiftKey && key === 'insert')) {
        event.preventDefault()
        void attachmentInputRef.current.paste()
        return false
      }
      if (event.ctrlKey && event.shiftKey && key === 'c') {
        if (term.hasSelection()) {
          event.preventDefault()
          void navigator.clipboard
            .writeText(term.getSelection())
            .catch(() => undefined)
          return false
        }
      }
      return true
    })

    const dataDisposable = term.onData((data) => {
      const ptyId = ptyIdRef.current
      if (ptyId) {
        writeQueue = writeQueue.catch(() => undefined).then(() => {
          if (disposed || ptyIdRef.current !== ptyId) throw new Error('对话已结束，输入未写入')
          return window.api.writeTerminal(ptyId, data)
        })
        void writeQueue.catch((error) => { if (!disposed) showToast({ kind: 'error', message: `写入对话失败：${String(error)}` }) })
      }
    })

    const offData = window.api.onTerminalData((event) => {
      if (disposed) return
      if (ptyIdRef.current) {
        if (event.ptyId === ptyIdRef.current) term.write(event.data)
      } else if (startPending && bufferedSize < 1024 * 1024) {
        const data = event.data.slice(0, 1024 * 1024 - bufferedSize)
        pendingData.push({ ...event, data })
        bufferedSize += data.length
      }
    })

    const offExit = window.api.onTerminalExit((event) => {
      if (disposed) return
      if (startPending && !ptyIdRef.current) {
        pendingExits.set(event.ptyId, event)
        return
      }
      if (!ptyIdRef.current || event.ptyId !== ptyIdRef.current) return
      ptyIdRef.current = null
      setRunning(false)
      setStatus(session.key, 'stopped')
      term.writeln(`\r\n[Claude 已退出，代码 ${event.exitCode}]`)
    })

    const resize = (): void => {
      if (disposed || !activeRef.current || container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      const ptyId = ptyIdRef.current
      if (ptyId && term.cols >= 20 && term.rows >= 5) {
        void window.api.resizeTerminal(ptyId, term.cols, term.rows).catch(() => undefined)
      }
    }
    resizeRef.current = resize
    const observer = new ResizeObserver(() => requestAnimationFrame(resize))
    observer.observe(container)

    const startPty = async (): Promise<void> => {
      if (disposed || startPending || ptyIdRef.current) return
      startPending = true
      pendingData.length = 0
      pendingExits.clear()
      bufferedSize = 0
      if (session.sessionId) clearTerminalActivity(session.sessionId)
      setStarting(true)
      setRunning(false)
      setStatus(session.key, 'starting')

      try {
        if (hasLaunched && session.kind !== 'resume') {
          const snapshot = await window.api.refresh()
          if (disposed) return
          useStore.getState().setSnapshot(snapshot)
        }
        const forkPending = session.kind === 'fork' &&
          Boolean(session.forkFromSessionId) &&
          !useStore.getState().snapshot?.sessions.some((item) => item.id === session.sessionId)
        const result = await window.api.startTerminal({
          cwd: session.cwd,
          ...(forkPending
            ? { newSessionId: session.sessionId, forkFromSessionId: session.forkFromSessionId }
            : session.kind === 'resume' || useStore.getState().snapshot?.sessions.some((s) => s.id === session.sessionId)
              ? { sessionId: session.sessionId ?? null }
              : { newSessionId: session.sessionId }),
          title: session.sessionTitle ?? session.projectName,
          mode: session.mode,
          cols: Math.max(20, Math.min(1000, term.cols || 100)),
          rows: Math.max(5, Math.min(500, term.rows || 30))
        })
        if (disposed) {
          if (result.ok && result.ptyId) void window.api.stopTerminal(result.ptyId).catch(() => undefined)
          return
        }
        if (!result.ok || !result.ptyId) throw new Error(result.message ?? '启动 Claude 终端失败')
        hasLaunched = true
        const revision = attachmentRevision
        void window.api.listAttachments(context).then((items) => {
          if (revision === attachmentRevision && !disposed) setAttachments(items)
        }).catch(() => undefined)

        ptyIdRef.current = result.ptyId ?? null
        for (const event of pendingData) {
          if (event.ptyId === result.ptyId) term.write(event.data)
        }
        const earlyExit = pendingExits.get(result.ptyId)
        if (earlyExit) {
          ptyIdRef.current = null
          setStatus(session.key, 'stopped')
          term.writeln(`\r\n[Claude 已退出，代码 ${earlyExit.exitCode}]`)
          return
        }
        setRunning(true)
        setStatus(session.key, 'running')
        if (activeRef.current) term.focus()
        requestAnimationFrame(resize)
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error)
          setRunning(false)
          setStatus(session.key, 'stopped')
          term.writeln(`\r\n[启动失败] ${message}`)
          showToast({ kind: 'error', message })
        }
      } finally {
        startPending = false
        pendingData.length = 0
        pendingExits.clear()
        bufferedSize = 0
        if (!disposed) setStarting(false)
      }
    }
    startRef.current = startPty

    const stopPty = async (): Promise<void> => {
      const ptyId = ptyIdRef.current
      if (ptyId) {
        await window.api.stopTerminal(ptyId)
        if (ptyIdRef.current === ptyId) {
          ptyIdRef.current = null
        }
        if (!disposed) {
          setRunning(false)
          setStatus(session.key, 'stopped')
        }
      }
    }
    const offStop = registerTerminalStopper(session.key, stopPty)
    stopRef.current = (): void => {
      void stopPty().catch((error: unknown) => {
        if (!disposed) showToast({ kind: 'error', message: `结束对话失败：${String(error)}` })
      })
    }

    restartRef.current = (): void => {
      if (startPending || restarting || disposed) return
      restarting = true
      setStarting(true)
      void (async () => {
        const ptyId = ptyIdRef.current
        if (ptyId) await window.api.stopTerminal(ptyId)
        ptyIdRef.current = null
        await startPty()
      })().catch((error: unknown) => {
        if (!disposed) showToast({ kind: 'error', message: String(error) })
      }).finally(() => {
        restarting = false
        if (!disposed) setStarting(false)
      })
    }

    if (!session.dormant) void startPty()

    return () => {
      disposed = true
      offStop()
      const ptyId = ptyIdRef.current
      if (ptyId) void window.api.stopTerminal(ptyId).catch(() => undefined)
      ptyIdRef.current = null
      dataDisposable.dispose()
      if (selectionTimer) clearTimeout(selectionTimer)
      selectionDisposable.dispose()
      offData()
      offExit()
      observer.disconnect()
      fileLinks.dispose()
      nativeFileLinks.dispose()
      container.removeEventListener('paste', onPaste, true)
      window.removeEventListener('csm:attachments-added', onAttachmentsAdded)
      hoveredFileRef.current = null
      darkQuery.removeEventListener('change', onThemeChange)
      textarea?.removeEventListener('focus', onFocus, true)
      textarea?.removeEventListener('blur', onBlur, true)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setFocused(false)
    }
  }, [session.key, setFocused, setStatus, showToast, clearTerminalActivity])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.theme =
      themeSetting === 'dark' ||
      (themeSetting === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? DARK_THEME
        : LIGHT_THEME
    resizeRef.current()
  }, [fontSize, themeSetting])

  useEffect(() => {
    if (!sessionKey) {
      setUsage(null)
      return undefined
    }
    let cancelled = false
    const load = (): void => {
      void window.api.getSessionUsage(sessionKey).then((value) => {
        if (!cancelled) setUsage(value)
      }).catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionKey])

  useEffect(() => {
    if (!active) {
      dragDepthRef.current = 0; setDragging(false)
      setMenuOpen(false); setClaudeMenuOpen(false); setFileMenu(null)
      return
    }
    const timer = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      resizeRef.current()
      if (draftRef.current.text || draftRef.current.files.length) draftInputRef.current?.focus()
      else termRef.current?.focus()
    })
    return () => cancelAnimationFrame(timer)
  }, [active])

  const dormant = session.dormant === true && !launched
  const usageCost = usage ? formatUsageCost(usage.costUSD) : null
  const usageTitle = usage
    ? [
        usage.model ?? '未知模型',
        `输入 ${formatCompactTokens(usage.inputTokens)} · 输出 ${formatCompactTokens(usage.outputTokens)}`,
        `缓存 ${formatCompactTokens(usage.cacheReadTokens + usage.cacheWriteTokens)}`,
        ...(usageCost ? [`估算 ${usageCost}`] : [])
      ].join('\n')
    : ''
  const status = starting
    ? '启动中…'
    : running
      ? activity === 'approval'
        ? '等待确认'
        : activity === 'working'
          ? '工作中…'
          : activity === 'idle'
            ? '等待输入'
            : '运行中'
      : session.dormant === true && !launched
        ? '未启动'
        : '已结束'
  const referencedAttachments = attachments.filter((item) => !draft.files.some((file) => file.path.toLowerCase() === item.path.toLowerCase()))

  const confirm = (): void => {
    const action = pending
    setPending(null)
    if (action === 'stop') stopRef.current()
    else if (action === 'restart') restartRef.current()
  }

  const runSlash = (command: string): void => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return
    setClaudeMenuOpen(false)
    setMenuOpen(false)
    termRef.current?.focus()
    void window.api.writeTerminal(ptyId, command).catch(() => undefined)
    window.setTimeout(() => {
      if (ptyIdRef.current === ptyId) {
        void window.api.writeTerminal(ptyId, '\r').catch(() => undefined)
        termRef.current?.focus()
      }
    }, 200)
  }

  const removeSession = async (): Promise<void> => {
    if (!summary) return
    setConfirmDelete(false)
    const ptyId = ptyIdRef.current
    if (ptyId) await window.api.stopTerminal(ptyId).catch(() => undefined)
    const result = await deleteSession(summary.key)
    if (result.ok) closeTerminal(session.key)
  }

  return (
    <div
      className={`terminal-tab-view ${active ? 'active' : ''}`}
      style={{ display: active ? 'flex' : 'none' }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault(); dragDepthRef.current += 1; setDragging(true)
      }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
      onDragLeave={(event) => {
        event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (!dragDepthRef.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault(); event.stopPropagation(); dragDepthRef.current = 0; setDragging(false)
        void attachmentInputRef.current.drop(Array.from(event.dataTransfer.files))
      }}
    >
      <header className="terminal-header">
        <div className="terminal-title">
          <MessageSquare size={15} />
          <span>Claude 对话</span>
          <span className="terminal-cwd" title={session.cwd}>
            {session.projectName} · {session.cwd}
          </span>
        </div>
        <span className="terminal-mode">权限：{MODE_LABELS[session.mode]}</span>
        {usage && usage.model && (
          <span className="terminal-usage" title={usageTitle}>
            <span className="terminal-model">{usage.model}</span>
            {usage.contextPercent !== null && usage.contextLimit !== null && (
              <span className={`terminal-context ${usage.contextPercent >= 80 ? 'high' : ''}`}>
                上下文 {usage.contextPercent.toFixed(0)}%
              </span>
            )}
          </span>
        )}
        <span className={`terminal-status ${running ? 'running' : 'stopped'} ${running ? activity ?? '' : ''}`}>
          <span className="terminal-dot" />
          {status}
        </span>
        <div className="terminal-actions">
          <button className="btn ghost" title="添加文件或图片" disabled={!running || attaching || sending}
            onClick={() => void attachmentInputRef.current.pick()}><Paperclip size={15} /></button>
          <button className="btn ghost" title="粘贴文件、截图或文本（Ctrl+V）" disabled={!running || attaching || sending}
            onClick={() => void attachmentInputRef.current.paste()}><ClipboardIcon size={15} /></button>
          <div className="terminal-menu-wrap" ref={claudeMenuRef}>
            <button
              className="btn ghost"
              title="Claude 功能：回退 / Skill / MCP"
              aria-haspopup="menu"
              aria-expanded={claudeMenuOpen}
              disabled={!running}
              onClick={() => {
                setClaudeMenuOpen((open) => !open)
                setMenuOpen(false)
              }}
            >
              <Sparkles size={15} />
            </button>
            {claudeMenuOpen && (
              <div className="menu" role="menu">
                <button role="menuitem" onClick={() => runSlash('/rewind')}>
                  <History size={14} />
                  回退到节点
                </button>
                <button role="menuitem" onClick={() => runSlash('/skills')}>
                  <ListChecks size={14} />
                  Skill 管理
                </button>
                <button role="menuitem" onClick={() => runSlash('/mcp')}>
                  <Plug size={14} />
                  MCP 管理
                </button>
              </div>
            )}
          </div>
          <button
            className="btn ghost"
            title="重新开始"
            disabled={starting}
            onClick={() => {
              if (running) setPending('restart')
              else void startRef.current()
            }}
          >
            <RotateCcw size={14} />
          </button>
          <button
            className="btn ghost"
            title="结束对话"
            disabled={!running}
            onClick={() => setPending('stop')}
          >
            <Square size={13} />
          </button>
          <div className="terminal-menu-wrap" ref={menuRef}>
            <button
              className="btn ghost"
              title="会话操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((open) => !open)
                setClaudeMenuOpen(false)
              }}
            >
              <MoreHorizontal size={15} />
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                {summary && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      selectSession(summary.key)
                    }}
                  >
                    <FileText size={14} />
                    查看会话记录
                  </button>
                )}
                {summary && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      void resumeSession(summary.key)
                    }}
                  >
                    <TerminalIcon size={14} />
                    在终端中恢复
                  </button>
                )}
                {summary && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      void exportSession(summary.key)
                    }}
                  >
                    <Download size={14} />
                    导出 Markdown
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void window.api.openFolder(session.cwd).then((result) => {
                      if (!result.ok) {
                        showToast({
                          kind: 'error',
                          message: result.message ?? '无法打开项目文件夹'
                        })
                      }
                    })
                  }}
                >
                  <FolderOpen size={14} />
                  在项目中打开
                </button>
                {summary && (
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setMenuOpen(false)
                      setConfirmDelete(true)
                    }}
                  >
                    <Trash2 size={14} />
                    删除会话
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {referencedAttachments.length > 0 && <div className="terminal-attachments" aria-label="已引用的附件">
        <span className="attachment-hint">已引用 · 移除记录会保留原文件</span>
        <button className="text-button attachment-clear" disabled={attaching || sending}
          onClick={() => void attachmentInputRef.current.remove(referencedAttachments.map((item) => item.id))}>清空记录</button>
        <div className="attachment-history-files">
        {referencedAttachments.map((item) => <span className="attachment-chip" key={item.path}>
          {item.preview && <img src={item.preview} alt="" />}
          <FileLink context={{ sessionId: session.sessionId }} reference={item.path}>{item.name}</FileLink>
          <button className="attachment-remove" title={`移除附件记录：${item.name}`} aria-label={`移除附件记录：${item.name}`}
            disabled={attaching || sending} onClick={() => void attachmentInputRef.current.remove([item.id])}><X size={13} /></button>
        </span>)}
        </div>
      </div>}
      <div className="terminal-body" ref={containerRef} onContextMenu={(event) => {
        const reference = hoveredFileRef.current
        if (reference && !/^https?:\/\//i.test(reference)) {
          event.preventDefault()
          setFileMenu({ reference, x: event.clientX, y: event.clientY })
          return
        }
        if (!rightClickPaste) return
        event.preventDefault()
        void (async () => {
          const term = termRef.current
          if (term?.hasSelection() && copyOnSelectRef.current) {
            await navigator.clipboard.writeText(term.getSelection()).catch(() => undefined)
            return
          }
          await attachmentInputRef.current.paste()
        })()
      }} />
      {dormant && (
        <div className="terminal-dormant">
          <div className="terminal-dormant-card">
            <strong>{session.sessionTitle ?? session.projectName}</strong>
            <p>
              {session.kind === 'resume'
                ? '上次打开的对话标签已恢复，继续后会使用原会话记录。'
                : session.kind === 'fork'
                  ? '上次创建的分叉对话标签已恢复；继续后会打开对应的新会话。'
                  : '上次未启动的对话标签已恢复，继续后会在原项目目录新建对话。'}
            </p>
            <div className="terminal-dormant-actions">
              <button
                className="btn primary"
                onClick={() => {
                  setLaunched(true)
                  startRef.current()
                }}
              >
                {session.kind === 'resume' || session.kind === 'fork' ? '继续对话' : '开始对话'}
              </button>
              <button className="btn" onClick={() => closeTerminal(session.key)}>关闭标签</button>
            </div>
          </div>
        </div>
      )}
      {(draft.text.length > 0 || draft.files.length > 0) && <section className="attachment-composer" aria-label="附件草稿">
        <div className="attachment-draft-files">
          <span className="attachment-hint">待发送</span>
          {draft.files.map((item) => <span className="attachment-chip pending-attachment" key={item.path}>
            {item.preview && <img src={item.preview} alt="" />}
            <FileLink context={{ sessionId: session.sessionId }} reference={item.path}>{item.name}</FileLink>
            <button className="attachment-remove" title={`移除待发送附件：${item.name}`} aria-label={`移除待发送附件：${item.name}`}
              disabled={attaching || sending} onClick={() => void attachmentInputRef.current.remove([item.id])}><X size={13} /></button>
          </span>)}
        </div>
        <textarea ref={draftInputRef} aria-label="待发送内容" value={draft.text} disabled={sending || attaching}
          placeholder="编辑文件路径或补充说明…" rows={3}
          onChange={(event) => setDraft((previous) => ({ ...previous, text: event.target.value }))}
          onPaste={(event) => {
            if (Array.from(event.clipboardData.items).some((item) => item.kind === 'file' || item.type.startsWith('image/') || item.type === 'text/uri-list')) {
              event.preventDefault(); void attachmentInputRef.current.paste(true)
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void attachmentInputRef.current.send(true) }
          }} />
        <div className="attachment-composer-actions">
          <span className="attachment-hint">可移除附件、编辑路径；Ctrl+Enter 发送</span>
          <button className="text-button" disabled={sending || attaching}
            onClick={() => void attachmentInputRef.current.remove(draft.files.map((item) => item.id), true)}>清空草稿</button>
          <button className="btn" disabled={!running || sending || attaching || !draft.text.trim()}
            onClick={() => void attachmentInputRef.current.send(false)}>仅插入终端</button>
          <button className="btn primary" disabled={!running || sending || attaching || !draft.text.trim()}
            onClick={() => void attachmentInputRef.current.send(true)}>{sending ? '处理中…' : '发送'}</button>
        </div>
      </section>}
      {dragging && <div className="terminal-drop-overlay">松开以添加文件或图片</div>}
      <FileReferenceMenu context={{ sessionId: session.sessionId }} target={fileMenu} onClose={() => setFileMenu(null)} />

      {pending && (
        <ConfirmDialog
          title={pending === 'restart' ? '重新开始对话' : '结束对话'}
          confirmLabel={pending === 'restart' ? '结束并重开' : '结束'}
          danger
          message={
            <p>
              当前 Claude 对话仍在运行。继续会结束这个终端会话，但 Claude 已写入磁盘的会话记录不会丢失。
            </p>
          }
          onCancel={() => setPending(null)}
          onConfirm={confirm}
        />
      )}

      {confirmDelete && summary && (
        <ConfirmDialog
          title="删除会话"
          confirmLabel="删除并关闭"
          danger
          message={
            <p>
              将删除「{summary.title}」及其附属数据，并移入系统回收站；
              当前终端会先结束，随后关闭该标签。
            </p>
          }
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void removeSession()}
        />
      )}
    </div>
  )
}
