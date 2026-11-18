import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeftRight,
  Download,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  PanelLeft,
  RefreshCw,
  Settings,
  Star,
  X
} from 'lucide-react'
import { openSessionConversation, refreshSnapshot, toggleFavorite, closeConversationTabs } from '../lib/actions'
import { filterPaletteItems } from '../lib/commandPalette'
import { useStore } from '../store'
import { useDialog } from '../lib/useDialog'

interface PaletteEntry {
  id: string
  label: string
  hint?: string
  keywords?: string
  icon: React.ReactNode
  run: () => void
}

function projectNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export default function CommandPalette({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const snapshot = useStore((state) => state.snapshot)
  const terminals = useStore((state) => state.terminals)
  const terminalStatus = useStore((state) => state.terminalStatus)
  const activeTab = useStore((state) => state.activeTab)
  const selectedKey = useStore((state) => state.selectedKey)
  const archived = useStore((state) => state.archived)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useDialog(open, onClose)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const selected = snapshot?.sessions.find((session) => session.key === selectedKey) ?? null
  const selectedArchived = Boolean(selected && archived.includes(selected.id))
  const activeTerminal = terminals.find((tab) => tab.key === activeTab) ?? null

  const commands = useMemo<PaletteEntry[]>(() => {
    const state = useStore.getState()
    const entries: PaletteEntry[] = []
    const newContext = selected?.projectPath
      ? { cwd: selected.projectPath, projectName: projectNameOf(selected.projectPath) }
      : snapshot?.projects[0]?.path
        ? { cwd: snapshot.projects[0].path, projectName: snapshot.projects[0].name }
        : null
    if (newContext) {
      entries.push({
        id: 'new-conversation',
        label: '新建对话',
        hint: newContext.projectName,
        keywords: 'new chat conversation',
        icon: <MessageSquarePlus size={15} />,
        run: () => state.openTerminalDialog({ kind: 'new', ...newContext })
      })
    }
    if (terminals.length > 0) {
      const position = terminals.findIndex((tab) => tab.key === activeTab)
      const next = terminals[(position + 1 + terminals.length) % terminals.length]
      const previous = terminals[(position - 1 + terminals.length) % terminals.length]
      entries.push({
        id: 'next-tab', label: '下一个对话标签', hint: next?.sessionTitle ?? next?.projectName,
        keywords: 'tab next', icon: <ArrowLeftRight size={15} />, run: () => next && state.setActiveTerminal(next.key)
      })
      entries.push({
        id: 'previous-tab', label: '上一个对话标签', hint: previous?.sessionTitle ?? previous?.projectName,
        keywords: 'tab previous', icon: <ArrowLeftRight size={15} />, run: () => previous && state.setActiveTerminal(previous.key)
      })
    }
    if (selected) {
      entries.push({
        id: 'open-record', label: '查看当前会话记录', keywords: 'record transcript',
        icon: <FileText size={15} />, run: () => state.selectSession(selected.key, null, null, true)
      })
      entries.push({
        id: 'toggle-favorite', label: selected.favorite ? '取消收藏当前会话' : '收藏当前会话',
        keywords: 'favorite star', icon: <Star size={15} />,
        run: () => void toggleFavorite(selected.key, !selected.favorite)
      })
      entries.push({
        id: 'toggle-archive', label: selectedArchived ? '取消归档当前会话' : '归档当前会话',
        keywords: 'archive hide', icon: <Archive size={15} />,
        run: () => {
          state.toggleSessionArchive(selected.id)
          if (!selectedArchived) state.selectSession(null)
        }
      })
      entries.push({
        id: 'export', label: '导出当前会话为 Markdown', keywords: 'export markdown',
        icon: <Download size={15} />,
        run: () => void window.api.exportSession(selected.key)
      })
      if (selected.projectPath) {
        entries.push({
          id: 'open-folder', label: '在文件夹中打开项目', keywords: 'folder reveal',
          icon: <FolderOpen size={15} />, run: () => void window.api.openFolder(selected.projectPath)
        })
      }
    }
    entries.push(
      { id: 'settings', label: '打开设置', keywords: 'settings preferences', icon: <Settings size={15} />, run: () => state.setSettingsOpen(true) },
      { id: 'refresh', label: '重新扫描会话', keywords: 'refresh rescan', icon: <RefreshCw size={15} />, run: () => void refreshSnapshot() },
      { id: 'toggle-rail', label: state.leftRailCollapsed ? '展开项目与会话' : '收起项目与会话', keywords: 'sidebar rail', icon: <PanelLeft size={15} />, run: () => state.toggleLeftRail() },
      { id: 'toggle-list', label: state.sessionListCollapsed ? '展开会话列表' : '收起会话列表', keywords: 'list panel', icon: <PanelLeft size={15} />, run: () => state.toggleSessionList() }
    )
    if (activeTerminal && terminalStatus[activeTerminal.key] === 'running') {
      entries.push({
        id: 'close-tab', label: '结束当前对话标签', keywords: 'close stop tab',
        icon: <X size={15} />,
        run: () => {
          void closeConversationTabs([activeTerminal.key])
        }
      })
    }
    return entries
  }, [snapshot, terminals, terminalStatus, activeTab, selected, selectedArchived, archived])

  const sessionEntries = useMemo<PaletteEntry[]>(() => {
    if (!snapshot) return []
    const state = useStore.getState()
    return [...snapshot.sessions]
      .filter((session) => session.source === 'transcript' && !archived.includes(session.id))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        id: `session:${session.key}`,
        label: session.title,
        hint: `${projectNameOf(session.projectPath)} · ${new Date(session.updatedAt).toLocaleDateString('zh-CN')}`,
        keywords: `${session.projectKey} ${session.projectPath}`,
        icon: <MessageSquarePlus size={15} />,
        run: () => {
          if (!openSessionConversation(session)) state.selectSession(session.key)
        }
      }))
  }, [snapshot, archived])

  const items = useMemo(() => {
    const result = filterPaletteItems(commands, query, query.trim() ? 6 : commands.length)
    const sessions = query.trim() ? filterPaletteItems(sessionEntries, query, 6) : []
    return [...result, ...sessions]
  }, [commands, sessionEntries, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  const choose = (entry: PaletteEntry | undefined): void => {
    if (!entry) return
    onClose()
    entry.run()
  }

  return (
    <div className="overlay palette-overlay" onMouseDown={onClose}>
      <div
        className="command-palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          aria-label="命令或会话"
          placeholder="输入命令或会话名称…（Ctrl+Shift+P）"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((current) => Math.min(items.length - 1, current + 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((current) => Math.max(0, current - 1))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              choose(items[index])
            }
          }}
        />
        <div className="palette-results" role="listbox" aria-label="匹配项">
          {items.length === 0 && <div className="palette-empty">没有匹配的命令或会话</div>}
          {items.map((entry, itemIndex) => (
            <button
              key={entry.id}
              role="option"
              aria-selected={itemIndex === index}
              className={`palette-item ${itemIndex === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => choose(entry)}
            >
              <span className="palette-icon">{entry.icon}</span>
              <span className="palette-label">{entry.label}</span>
              {entry.hint && <span className="palette-hint">{entry.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}