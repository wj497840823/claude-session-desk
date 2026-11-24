import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApprovalBroker,
  approvalInputFromHook,
  type ApprovalRequestInput
} from '../src/main/approvalBroker'

const input: ApprovalRequestInput = {
  ptyId: 'pty-1',
  sessionId: 'session-1',
  title: '测试对话',
  toolName: 'Bash',
  toolInput: '{"command":"npm test"}',
  cwd: 'E:\\repo'
}

afterEach(() => {
  vi.useRealTimers()
})

function ids(): () => string {
  let next = 0
  return () => `approval-${++next}`
}

describe('ApprovalBroker', () => {
  it('publishes a pending approval and resolves the chosen decision', async () => {
    const changes: number[] = []
    const broker = new ApprovalBroker({
      createId: ids(),
      now: () => 1000,
      onChange: (requests) => changes.push(requests.length)
    })

    const pending = broker.request(input, 5000)
    expect(broker.list()).toEqual([
      { ...input, id: 'approval-1', createdAt: 1000, expiresAt: 6000 }
    ])
    expect(broker.pendingCount()).toBe(1)

    expect(broker.resolve('approval-1', 'allow')).toBe(true)
    await expect(pending).resolves.toBe('allow')
    expect(broker.list()).toEqual([])
    expect(changes).toEqual([1, 0])
  })

  it('resolves with null when the user does not answer in time', async () => {
    vi.useFakeTimers()
    const broker = new ApprovalBroker({ createId: ids(), now: () => 0 })
    const pending = broker.request(input, 5000)

    await vi.advanceTimersByTimeAsync(4999)
    expect(broker.list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeNull()
    expect(broker.list()).toEqual([])
  })

  it('cancels only the requests belonging to a closed pty', async () => {
    const broker = new ApprovalBroker({ createId: ids(), now: () => 0 })
    const first = broker.request({ ...input, ptyId: 'pty-a' }, 5000)
    const second = broker.request({ ...input, ptyId: 'pty-b' }, 5000)

    broker.cancelForPty('pty-a')
    await expect(first).resolves.toBeNull()
    expect(broker.list().map((request) => request.ptyId)).toEqual(['pty-b'])

    expect(broker.resolve('approval-2', 'deny')).toBe(true)
    await expect(second).resolves.toBe('deny')
  })

  it('accepts only the first resolution and ignores unknown ids', async () => {
    const broker = new ApprovalBroker({ createId: ids(), now: () => 0 })
    const pending = broker.request(input, 5000)

    expect(broker.resolve('missing', 'allow')).toBe(false)
    expect(broker.resolve('approval-1', 'deny')).toBe(true)
    expect(broker.resolve('approval-1', 'allow')).toBe(false)
    expect(broker.resolve('approval-1', 'deny')).toBe(false)
    await expect(pending).resolves.toBe('deny')
  })

  it('rejects new requests after dispose and clears pending ones', async () => {
    const broker = new ApprovalBroker({ createId: ids(), now: () => 0 })
    const pending = broker.request(input, 5000)
    broker.dispose()
    await expect(pending).resolves.toBeNull()
    await expect(broker.request(input, 5000)).resolves.toBeNull()
  })
})

describe('approvalInputFromHook', () => {
  it('extracts the permission request summary', () => {
    expect(
      approvalInputFromHook(
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          cwd: 'E:\\repo'
        },
        'pty-1',
        'session-1',
        '测试对话'
      )
    ).toEqual({
      ptyId: 'pty-1',
      sessionId: 'session-1',
      title: '测试对话',
      toolName: 'Bash',
      toolInput: '{"command":"npm test"}',
      cwd: 'E:\\repo'
    })
  })

  it('ignores events that are not permission requests', () => {
    expect(approvalInputFromHook({ hook_event_name: 'Stop' }, 'pty-1', 's', 't')).toBeNull()
    expect(approvalInputFromHook(null, 'pty-1', 's', 't')).toBeNull()
    expect(approvalInputFromHook({}, 'pty-1', 's', 't')).toBeNull()
  })

  it('caps long tool input and missing tool names', () => {
    const result = approvalInputFromHook(
      {
        hook_event_name: 'PermissionRequest',
        tool_input: { content: 'x'.repeat(10_000) }
      },
      'pty-1',
      'session-1',
      ''
    )
    expect(result).not.toBeNull()
    expect(result?.toolName).toBe('需要确认的操作')
    expect(result?.title).toBe('Claude 对话')
    expect(result?.toolInput.length).toBe(4000)
  })
})