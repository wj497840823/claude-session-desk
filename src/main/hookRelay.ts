import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export type HookRelayHandler = (event: unknown) => void

export interface HookRelayLike {
  urlFor(ptyId: string): string | null
  register(ptyId: string, handler: HookRelayHandler): void
  unregister(ptyId: string): void
}

const MAX_BODY_BYTES = 64 * 1024

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reply(response: ServerResponse, status: number): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end('{}')
}

export class HookRelayService implements HookRelayLike {
  private server: Server | null = null
  private port = 0
  private readonly token = randomBytes(24).toString('hex')
  private readonly handlers = new Map<string, HookRelayHandler>()
  private starting: Promise<boolean> | null = null

  async start(): Promise<boolean> {
    if (this.server) return true
    if (this.starting) return this.starting
    this.starting = new Promise<boolean>((resolve) => {
      const server = createServer((request, response) => this.handle(request, response))
      let settled = false
      // Keep a persistent listener: after startup, an error event must not
      // become an uncaught exception in the Electron main process.
      server.on('error', () => {
        if (settled) return
        settled = true
        resolve(false)
      })
      server.listen(0, '127.0.0.1', () => {
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
    const started = await this.starting
    this.starting = null
    return started
  }

  get running(): boolean {
    return this.server !== null
  }

  urlFor(ptyId: string): string | null {
    if (!this.server || !this.port) return null
    return `http://127.0.0.1:${this.port}/${this.token}/${encodeURIComponent(ptyId)}`
  }

  register(ptyId: string, handler: HookRelayHandler): void {
    this.handlers.set(ptyId, handler)
  }

  unregister(ptyId: string): void {
    this.handlers.delete(ptyId)
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    this.handlers.clear()
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST') {
      reply(response, 405)
      return
    }
    let parts: string[]
    try {
      parts = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.split('/').filter(Boolean)
    } catch {
      reply(response, 404)
      return
    }
    if (parts.length !== 2 || !tokensEqual(parts[0], this.token)) {
      reply(response, 404)
      return
    }
    let ptyId: string
    try {
      ptyId = decodeURIComponent(parts[1])
    } catch {
      reply(response, 404)
      return
    }
    const handler = this.handlers.get(ptyId)
    if (!handler) {
      reply(response, 404)
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let finished = false
    request.on('data', (chunk: Buffer) => {
      if (finished) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finished = true
        reply(response, 413)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (finished) return
      finished = true
      reply(response, 200)
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text) handler(JSON.parse(text))
      } catch {
        // Malformed payloads must not affect the CLI or the app.
      }
    })
    request.on('error', () => {
      if (finished) return
      finished = true
      try {
        reply(response, 200)
      } catch {
        // The socket may already be gone.
      }
    })
  }
}