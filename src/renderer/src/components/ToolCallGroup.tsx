import { Wrench } from 'lucide-react'
import type { ToolCall, FileContext } from '@shared/types'
import { FileLink } from './FileLinks'

function ToolCallRow({ call, context }: { call: ToolCall; context: FileContext }): React.JSX.Element {
  return (
    <div className="tool-call">
      <div className="tool-call-name">{call.name}</div>
      <div className="tool-call-section">输入</div>
      <pre>{call.input || '（无参数）'}</pre>
      {call.files && <div className="tool-file-links">{call.files.map((path) =>
        <FileLink key={path} context={context} reference={path} />)}</div>}
      <div className="tool-call-section">
        {call.isError ? '结果（错误）' : '结果'}
      </div>
      {call.result ? (
        <pre className={call.isError ? 'error' : ''}>{call.result}</pre>
      ) : (
        <div className="tool-pending">等待结果…</div>
      )}
      {call.persistedOutputPath && (
        <FileLink context={context} reference={call.persistedOutputPath}>
          打开完整输出
        </FileLink>
      )}
    </div>
  )
}

export default function ToolCallGroup({
  calls, context
}: {
  calls: ToolCall[]
  context: FileContext
}): React.JSX.Element {
  const label =
    calls.length === 1
      ? calls[0].inputSummary
      : `${calls.length} 个工具调用：${calls.map((call) => call.name).join('、')}`

  return (
    <details className="tool-group">
      <summary>
        <Wrench size={13} />
        <span>{label}</span>
      </summary>
      <div className="tool-calls">
        {calls.map((call) => (
          <ToolCallRow key={call.id} call={call} context={context} />
        ))}
      </div>
    </details>
  )
}
