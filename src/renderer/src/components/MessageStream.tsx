import { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { SessionDetail } from '@shared/types'
import { initialStart, loadEarlier } from '../lib/pagination'
import ToolCallGroup from './ToolCallGroup'
import { FileLink, FileText, fileTextChildren } from './FileLinks'
import { parseFileReference } from '@shared/fileReferences'

function CodeBlock({
  children
}: React.ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="code-wrap">
      <button
        className="code-copy"
        onClick={() => {
          void navigator.clipboard.writeText(ref.current?.innerText ?? '')
        }}
      >
        复制
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function formatClock(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatFull(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString('zh-CN')
}

export default function MessageStream({
  detail,
  matchUuid,
  focusUuid = null
}: {
  detail: SessionDetail
  matchUuid: string | null
  focusUuid?: string | null
}): React.JSX.Element {
  const targetUuid = focusUuid ?? matchUuid
  const [start, setStart] = useState(() =>
    initialStart(detail.events.length, detail.events, targetUuid)
  )
  const [highlight, setHighlight] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setStart(initialStart(detail.events.length, detail.events, matchUuid))
    setHighlight(null)
  }, [detail.key, detail.events, matchUuid])

  useEffect(() => {
    if (!targetUuid) return
    const index = detail.events.findIndex((event) => event.uuid === targetUuid)
    if (index < 0) return
    setStart((current) => index < current ? Math.max(0, index - 50) : current)
  }, [detail.events, targetUuid])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    if (targetUuid) {
      const timer = requestAnimationFrame(() => {
        const target = container.querySelector<HTMLElement>(
          `[data-uuid="${CSS.escape(targetUuid)}"]`
        )
        if (target) {
          target.scrollIntoView({ block: 'center' })
          setHighlight(targetUuid)
          window.setTimeout(() => setHighlight(null), 2000)
        }
      })
      return () => cancelAnimationFrame(timer)
    }
    container.scrollTop = container.scrollHeight
    return undefined
  }, [detail.key, targetUuid, start])

  const events = detail.events.slice(start)
  const context = { sessionKey: detail.key }

  return (
    <div className="message-stream" ref={containerRef}>
      {start > 0 && (
        <button className="load-earlier" onClick={() => setStart(loadEarlier(start))}>
          加载更早的 {Math.min(start, 150)} 条
        </button>
      )}

      {events.map((event, index) => {
        const key = `${event.uuid}-${start + index}`
        const highlighted = highlight !== null && event.uuid === highlight

        if (event.kind === 'tools') {
          return (
            <div
              key={key}
              data-uuid={event.uuid}
              className={`message ${highlighted ? 'highlight' : ''}`}
            >
              <ToolCallGroup calls={event.calls} context={context} />
            </div>
          )
        }

        if (event.kind === 'user') {
          return (
            <div
              key={key}
              data-uuid={event.uuid}
              className={`message user ${highlighted ? 'highlight' : ''}`}
            >
              <div className="message-label">你</div>
              <div className="bubble"><FileText text={event.text} context={context} /></div>
              <div className="message-time" title={formatFull(event.timestamp)}>
                {formatClock(event.timestamp)}
              </div>
            </div>
          )
        }

        if (event.kind === 'assistant' && !event.text.trim()) return null

        return (
          <div
            key={key}
            data-uuid={event.uuid}
            className={`message assistant ${highlighted ? 'highlight' : ''}`}
          >
            <div className="message-label">
              助手{event.model ? ` · ${event.model}` : ''}
            </div>
            <div className="bubble markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                urlTransform={(url) => parseFileReference(url) ? url : defaultUrlTransform(url)}
                components={{
                  pre: CodeBlock,
                  a: ({ href, children }) => href?.startsWith('#') ? <a href={href}>{children}</a> :
                    <FileLink reference={href ?? ''} context={context}>{children}</FileLink>,
                  img: ({ src, alt }) => <FileLink reference={typeof src === 'string' ? src : ''} context={context}>{alt || '打开图片'}</FileLink>,
                  p: ({ children }) => <p>{fileTextChildren(context, children)}</p>,
                  li: ({ children }) => <li>{fileTextChildren(context, children)}</li>,
                  strong: ({ children }) => <strong>{fileTextChildren(context, children)}</strong>,
                  code: ({ children, className }) => <code className={className}>{
                    !className && typeof children === 'string' && !children.includes('\n')
                      ? <FileText text={children} context={context} /> : children
                  }</code>
                }}
              >
                {event.text}
              </ReactMarkdown>
            </div>
            <div className="message-time" title={formatFull(event.timestamp)}>
              {formatClock(event.timestamp)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
