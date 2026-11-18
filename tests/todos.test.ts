import { describe, expect, it } from 'vitest'
import type { SessionEvent, ToolCall } from '../src/shared/types'
import { latestTodos, todoProgress } from '../src/shared/todos'

const call = (id: string, todos?: ToolCall['todos']): SessionEvent => ({
  kind: 'tools',
  uuid: id,
  timestamp: 1,
  calls: [{ id, name: 'TodoWrite', inputSummary: '更新任务', input: '{}', ...(todos ? { todos } : {}) }]
})

describe('latestTodos', () => {
  it('returns the most recent TodoWrite list', () => {
    const first = [{ content: '读代码', status: 'completed' as const }]
    const second = [
      { content: '读代码', status: 'completed' as const },
      { content: '写测试', status: 'in_progress' as const }
    ]
    expect(latestTodos([call('a', first), call('b', second)])).toEqual(second)
  })

  it('keeps the latest list when a newer turn has no TodoWrite call', () => {
    const list = [{ content: '验证', status: 'pending' as const }]
    expect(latestTodos([call('a', list), {
      kind: 'assistant', uuid: 'c', timestamp: 2, text: 'done'
    }])).toEqual(list)
  })

  it('returns null when the session has no task list', () => {
    expect(latestTodos([])).toBeNull()
  })
})

describe('todoProgress', () => {
  it('counts completed items and total items', () => {
    expect(todoProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' }
    ])).toEqual({ completed: 1, total: 3 })
  })
})