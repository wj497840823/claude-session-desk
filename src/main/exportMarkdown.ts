import type { SessionDetail, ToolCall } from '@shared/types'

export function safeExportFileName(title: string, sessionId: string): string {
  const base =
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '会话'
  return `${base}-${sessionId.slice(0, 8)}.md`
}

function fenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

function fenced(content: string, language = ''): string {
  const fence = fenceFor(content)
  return `${fence}${language}\n${content}\n${fence}`
}

function toolMarkdown(call: ToolCall): string {
  const lines = [`### 工具：${call.name}`, '', '**输入**', '', fenced(call.input, 'json')]
  if (call.result) {
    lines.push('', call.isError ? '**结果（错误）**' : '**结果**', '', fenced(call.result))
  }
  if (call.persistedOutputPath) {
    lines.push('', `完整输出：\`${call.persistedOutputPath}\``)
  }
  return lines.join('\n')
}

export function buildMarkdown(detail: SessionDetail): string {
  const lines: string[] = [
    `# ${detail.title}`,
    '',
    `- 项目：\`${detail.projectPath || '未知'}\``,
    `- 会话 ID：\`${detail.id}\``,
    `- 创建时间：${new Date(detail.createdAt).toLocaleString('zh-CN')}`,
    `- 更新时间：${new Date(detail.updatedAt).toLocaleString('zh-CN')}`,
    `- 消息数：${detail.totalEvents}`,
    ''
  ]

  for (const event of detail.events) {
    if (event.kind === 'user') {
      lines.push('## 用户', '', event.text, '')
    } else if (event.kind === 'assistant') {
      lines.push('## 助手', '', event.text, '')
    } else {
      for (const call of event.calls) {
        lines.push(toolMarkdown(call), '')
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}