import { randomUUID } from 'node:crypto'

export type ApprovalDecision = 'allow' | 'deny'

export interface ApprovalRequestInput {
  ptyId: string
  sessionId: string
  title: string
  toolName: string
  toolInput: string
  cwd?: string
}

export interface ApprovalRequest extends ApprovalRequestInput {
  id: string
  createdAt: number
  expiresAt: number
}

export interface ApprovalBrokerOptions {
  timeoutMs?: number
  now?: () => number
  createId?: () => string
  onChange?: (requests: ApprovalRequest[]) => void
  notify?: (request: ApprovalRequest) => void
}

interface PendingApproval {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision | null) => void
  timer: ReturnType<typeof setTimeout>
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000
const MAX_TITLE = 120
const MAX_TOOL_NAME = 120
const MAX_TOOL_INPUT = 4000
const MAX_CWD = 500

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function summarizeToolInput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Turns a Claude Code `PermissionRequest` hook payload into the data shown in
 * the approval inbox. Everything is local display data; no decision is made
 * here.
 */
export function approvalInputFromHook(
  event: unknown,
  ptyId: string,
  sessionId: string,
  title: string
): ApprovalRequestInput | null {
  if (!event || typeof event !== 'object') return null
  const value = event as Record<string, unknown>
  if (value.hook_event_name !== 'PermissionRequest') return null

  const rawToolName = typeof value.tool_name === 'string' ? value.tool_name.trim() : ''
  const toolInput = summarizeToolInput(value.tool_input)
  const cwd = typeof value.cwd === 'string' && value.cwd
    ? cap(value.cwd, MAX_CWD)
    : undefined

  return {
    ptyId,
    sessionId,
    title: title.trim() ? cap(title.trim(), MAX_TITLE) : 'Claude 对话',
    toolName: rawToolName ? cap(rawToolName, MAX_TOOL_NAME) : '需要确认的操作',
    toolInput: cap(toolInput, MAX_TOOL_INPUT),
    cwd
  }
}

/**
 * Holds permission requests while the user decides. A request that is not
 * answered before its timeout resolves as `null`, which lets the hook return an
 * empty decision and fall back to Claude's native permission prompt.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly createId: () => string
  private readonly onChange?: (requests: ApprovalRequest[]) => void
  private readonly notify?: (request: ApprovalRequest) => void
  private disposed = false

  constructor(options: ApprovalBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.onChange = options.onChange
    this.notify = options.notify
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  pendingCount(): number {
    return this.pending.size
  }

  request(
    input: ApprovalRequestInput,
    timeoutMs: number = this.timeoutMs
  ): Promise<ApprovalDecision | null> {
    if (this.disposed || timeoutMs <= 0) return Promise.resolve(null)
    const id = this.nextId()
    const createdAt = this.now()
    const request: ApprovalRequest = {
      ...input,
      id,
      createdAt,
      expiresAt: createdAt + timeoutMs
    }
    return new Promise<ApprovalDecision | null>((resolve) => {
      const timer = setTimeout(() => this.finish(id, null), timeoutMs)
      timer.unref?.()
      this.pending.set(id, { request, resolve, timer })
      this.changed()
      this.safeNotify(request)
    })
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    if (!this.pending.has(id)) return false
    this.finish(id, decision)
    return true
  }

  cancelForPty(ptyId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.ptyId === ptyId) this.finish(id, null)
    }
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, null)
  }

  dispose(): void {
    this.disposed = true
    this.cancelAll()
  }

  private nextId(): string {
    let id = this.createId()
    while (this.pending.has(id)) id = this.createId()
    return id
  }

  private finish(id: string, decision: ApprovalDecision | null): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(decision)
    this.changed()
  }

  private changed(): void {
    try {
      this.onChange?.(this.list())
    } catch {
      // A renderer or notification failure must not affect the hook response.
    }
  }

  private safeNotify(request: ApprovalRequest): void {
    try {
      this.notify?.(request)
    } catch {
      // Notifications are best-effort.
    }
  }
}