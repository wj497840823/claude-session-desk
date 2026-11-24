import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type {
  ActionResult,
  EventDispatchResult,
  ExternalEvent,
  InboxItem,
  LocalApiInfo,
  ScheduledTask,
  UsageSummary
} from '@shared/types'
import { sanitizeExternalEvent } from './events'

export interface LocalApiHandlers {
  status: () => unknown
  listTasks: () => ScheduledTask[]
  listInbox: () => InboxItem[]
  runTask: (id: string) => Promise<ActionResult>
  pauseTask: (id: string, until: number, reason?: string) => Promise<ScheduledTask>
  resumeTask: (id: string) => Promise<{ task: ScheduledTask; skipped: number }>
  replayTask: (id: string) => Promise<ActionResult>
  answerApproval: (id: string, decision: 'allow' | 'deny') => boolean
  answerAsk: (taskId: string, answer: { choice?: number; text?: string }) => Promise<ActionResult>
  ignoreAsk: (taskId: string) => Promise<ActionResult>
  emitEvent: (event: ExternalEvent) => Promise<EventDispatchResult>
  usage: () => UsageSummary
}

export interface LocalApiOptions {
  token: string
  handlers: LocalApiHandlers
  host?: string
  port?: number
  maxBodyBytes?: number
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return
  try {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(JSON.stringify(body))
  } catch {
    // The client may have disconnected.
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  const direct = request.headers['x-local-api-token']
  const supplied = typeof header === 'string' && /^Bearer\s+(.+)$/i.exec(header)?.[1]
    ? /^Bearer\s+(.+)$/i.exec(header)![1]
    : typeof direct === 'string' ? direct : ''
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    let settled = false
    const fail = (error: HttpError): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        request.resume()
        fail(new HttpError(413, '请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'JSON 格式错误'))
      }
    })
    request.on('error', () => fail(new HttpError(400, '读取请求失败')))
  })
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new HttpError(400, '非法路径参数')
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

/**
 * A token-protected HTTP surface bound to loopback. It exposes task control,
 * the unified inbox and the external event entry without granting any new
 * execution scope: tasks, cwd and permissions still come from local rules.
 */
export class LocalApiService {
  private server: Server | null = null
  private port = 0
  private readonly host: string
  private readonly requestedPort: number
  private readonly maxBodyBytes: number

  constructor(private readonly options: LocalApiOptions) {
    this.host = options.host ?? '127.0.0.1'
    this.requestedPort = options.port ?? 0
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024
  }

  get info(): LocalApiInfo {
    return {
      enabled: this.server !== null,
      url: this.server && this.port ? `http://127.0.0.1:${this.port}` : null,
      token: this.options.token
    }
  }

  async start(): Promise<boolean> {
    if (this.server) return true
    return new Promise<boolean>((resolve) => {
      const server = createServer((request, response) => this.handle(request, response))
      let settled = false
      server.on('error', () => {
        if (settled) return
        settled = true
        resolve(false)
      })
      server.listen(this.requestedPort, this.host, () => {
        if (settled) {
          server.close()
          return
        }
        settled = true
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          resolve(false)
          return
        }
        this.server = server
        this.port = address.port
        resolve(true)
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.route(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { ok: false, error: error.message })
        return
      }
      sendJson(response, 500, { ok: false, error: '内部错误' })
    })
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request, this.options.token)) {
      request.resume()
      sendJson(response, 401, { ok: false, error: '未授权' })
      return
    }
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      throw new HttpError(400, '非法路径')
    }
    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] !== 'v1') throw new HttpError(404, '接口不存在')
    const method = request.method ?? 'GET'
    const handlers = this.options.handlers

    if (method === 'GET') {
      if (parts.length !== 2) throw new HttpError(404, '接口不存在')
      switch (parts[1]) {
        case 'health':
          sendJson(response, 200, { ok: true })
          return
        case 'status':
          sendJson(response, 200, handlers.status())
          return
        case 'tasks':
          sendJson(response, 200, handlers.listTasks())
          return
        case 'inbox':
          sendJson(response, 200, handlers.listInbox())
          return
        case 'usage':
          sendJson(response, 200, handlers.usage())
          return
        default:
          throw new HttpError(404, '接口不存在')
      }
    }

    if (method !== 'POST') throw new HttpError(405, '方法不允许')
    const body = objectBody(await readBody(request, this.maxBodyBytes))

    if (parts[1] === 'tasks' && parts.length === 4) {
      const id = decodeId(parts[2])
      const action = parts[3]
      if (action === 'run') {
        sendJson(response, 200, await handlers.runTask(id))
        return
      }
      if (action === 'pause') {
        const minutes = body.minutes === undefined ? 60 : Number(body.minutes)
        const until = body.until === undefined
          ? Date.now() + minutes * 60_000
          : Number(body.until)
        if (!Number.isFinite(until) || !Number.isFinite(minutes) || minutes <= 0) {
          throw new HttpError(400, '非法暂停时间')
        }
        if (until <= Date.now()) throw new HttpError(400, '暂停结束时间必须在未来')
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined
        sendJson(response, 200, await handlers.pauseTask(id, until, reason))
        return
      }
      if (action === 'resume') {
        sendJson(response, 200, await handlers.resumeTask(id))
        return
      }
      if (action === 'replay') {
        sendJson(response, 200, await handlers.replayTask(id))
        return
      }
      throw new HttpError(404, '接口不存在')
    }

    if (parts[1] === 'approvals' && parts.length === 3) {
      const decision = body.decision
      if (decision !== 'allow' && decision !== 'deny') {
        throw new HttpError(400, 'decision 必须是 allow 或 deny')
      }
      const changed = handlers.answerApproval(decodeId(parts[2]), decision)
      if (!changed) throw new HttpError(404, '审批已失效')
      sendJson(response, 200, { ok: true })
      return
    }

    if (parts[1] === 'asks' && parts.length === 3) {
      const choice = body.choice
      const text = body.text
      if (choice !== undefined && (typeof choice !== 'number' || !Number.isInteger(choice))) {
        throw new HttpError(400, '非法选项')
      }
      if (text !== undefined && typeof text !== 'string') {
        throw new HttpError(400, '非法回答')
      }
      sendJson(response, 200, await handlers.answerAsk(decodeId(parts[2]), {
        ...(choice !== undefined ? { choice: choice as number } : {}),
        ...(text !== undefined ? { text } : {})
      }))
      return
    }

    if (parts[1] === 'asks' && parts.length === 4 && parts[3] === 'ignore') {
      sendJson(response, 200, await handlers.ignoreAsk(decodeId(parts[2])))
      return
    }

    if (parts[1] === 'events' && parts.length === 2) {
      const event = sanitizeExternalEvent(body)
      if (!event) throw new HttpError(400, '非法事件')
      sendJson(response, 200, { ok: true, ...(await handlers.emitEvent(event)) })
      return
    }

    throw new HttpError(404, '接口不存在')
  }
}

export async function loadOrCreateApiToken(userData: string): Promise<string> {
  const file = join(userData, 'local-api-token')
  try {
    const value = (await readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(value)) return value
  } catch {
    // Create a new token below.
  }
  const token = randomBytes(32).toString('hex')
  await mkdir(userData, { recursive: true })
  await writeFile(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}