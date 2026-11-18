import type { SessionEvent, TodoItem } from './types'

export function latestTodos(events: SessionEvent[]): TodoItem[] | null {
  let latest: TodoItem[] | null = null
  for (const event of events) {
    if (event.kind !== 'tools') continue
    for (const call of event.calls) {
      if (call.todos && call.todos.length) latest = call.todos
    }
  }
  return latest
}

export function todoProgress(todos: readonly TodoItem[]): { completed: number; total: number } {
  return {
    completed: todos.filter((item) => item.status === 'completed').length,
    total: todos.length
  }
}