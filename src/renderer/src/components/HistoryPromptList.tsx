import { useEffect, useRef, useState } from 'react'
import type { HistoryPrompt } from '@shared/types'

function formatDate(timestamp: number): string {
  if (!timestamp) return '时间未知'
  return new Date(timestamp).toLocaleString('zh-CN')
}

export default function HistoryPromptList({
  prompts,
  matchPromptIndex
}: {
  prompts: HistoryPrompt[]
  matchPromptIndex: number | null
}): React.JSX.Element {
  const [highlight, setHighlight] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (matchPromptIndex === null) return undefined
    const target = containerRef.current?.querySelector<HTMLElement>(
      `[data-prompt-index="${matchPromptIndex}"]`
    )
    if (!target) return undefined
    target.scrollIntoView({ block: 'center' })
    setHighlight(matchPromptIndex)
    const timer = setTimeout(() => setHighlight(null), 2000)
    return () => clearTimeout(timer)
  }, [matchPromptIndex, prompts])

  return (
    <div className="history-prompt-list" ref={containerRef}>
      <div className="history-notice">
        <strong>仅历史记录</strong>
        <p>
          Claude Code 已按默认 30 天保留策略删除完整对话文件。下面只保留本机记录的提示词和粘贴内容，
          无法查看助手回复，也无法恢复会话。
        </p>
      </div>

      {prompts.map((prompt) => (
        <div
          key={prompt.index}
          data-prompt-index={prompt.index}
          className={`history-prompt ${
            highlight === prompt.index ? 'highlight' : ''
          }`}
        >
          <div className="history-prompt-head">
            <span>提示 {prompt.index + 1}</span>
            <span>{formatDate(prompt.timestamp)}</span>
          </div>
          <div className="history-prompt-text">{prompt.display}</div>
          {prompt.pastedContents.length > 0 && (
            <details className="pasted-content">
              <summary>粘贴内容（{prompt.pastedContents.length}）</summary>
              {prompt.pastedContents.map((item) => (
                <pre key={item.id}>{item.content}</pre>
              ))}
            </details>
          )}
        </div>
      ))}
    </div>
  )
}