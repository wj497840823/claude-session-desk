import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppTheme,
  type SessionClickAction,
  type TerminalPermissionMode
} from '@shared/types'
import type { SessionMeta } from './parser'

export interface CachedMeta {
  mtimeMs: number
  size: number
  meta: SessionMeta
}

export interface MetaCache {
  version: 1
  sessions: Record<string, CachedMeta>
}

interface AppConfig {
  version: 1
  favorites: string[]
  settings?: Partial<AppSettings>
}

const DEFAULT_CONFIG: AppConfig = { version: 1, favorites: [] }
const THEMES: AppTheme[] = ['system', 'light', 'dark']
const PERMISSION_MODES: TerminalPermissionMode[] = [
  'follow',
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'dontAsk'
]
const SESSION_CLICK_ACTIONS: SessionClickAction[] = ['continue', 'record']

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as T) : fallback
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
    await rename(tempPath, filePath)
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

function normalizeSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const settings = raw ?? {}
  return {
    loadHistory:
      typeof settings.loadHistory === 'boolean'
        ? settings.loadHistory
        : DEFAULT_APP_SETTINGS.loadHistory,
    minimizeToTray:
      typeof settings.minimizeToTray === 'boolean'
        ? settings.minimizeToTray
        : DEFAULT_APP_SETTINGS.minimizeToTray,
    desktopNotifications:
      typeof settings.desktopNotifications === 'boolean'
        ? settings.desktopNotifications
        : DEFAULT_APP_SETTINGS.desktopNotifications,
    terminalCopyOnSelect:
      typeof settings.terminalCopyOnSelect === 'boolean'
        ? settings.terminalCopyOnSelect
        : DEFAULT_APP_SETTINGS.terminalCopyOnSelect,
    terminalRightClickPaste:
      typeof settings.terminalRightClickPaste === 'boolean'
        ? settings.terminalRightClickPaste
        : DEFAULT_APP_SETTINGS.terminalRightClickPaste,
    theme:
      typeof settings.theme === 'string' &&
      THEMES.includes(settings.theme as AppTheme)
        ? (settings.theme as AppTheme)
        : DEFAULT_APP_SETTINGS.theme,
    defaultPermissionMode:
      typeof settings.defaultPermissionMode === 'string' &&
      PERMISSION_MODES.includes(
        settings.defaultPermissionMode as TerminalPermissionMode
      )
        ? (settings.defaultPermissionMode as TerminalPermissionMode)
        : DEFAULT_APP_SETTINGS.defaultPermissionMode,
    terminalFontSize:
      typeof settings.terminalFontSize === 'number' &&
      Number.isInteger(settings.terminalFontSize) &&
      settings.terminalFontSize >= 10 &&
      settings.terminalFontSize <= 24
        ? settings.terminalFontSize
        : DEFAULT_APP_SETTINGS.terminalFontSize,
    sessionClickAction:
      typeof settings.sessionClickAction === 'string' &&
      SESSION_CLICK_ACTIONS.includes(
        settings.sessionClickAction as SessionClickAction
      )
        ? (settings.sessionClickAction as SessionClickAction)
        : DEFAULT_APP_SETTINGS.sessionClickAction
  }
}

export class ConfigStore {
  private configWrite: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  // Serialize the whole read/modify/write transaction, not just the rename.
  private enqueueConfig<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.configWrite.then(operation)
    this.configWrite = pending.then(() => undefined, () => undefined)
    return pending
  }

  get configPath(): string {
    return join(this.dir, 'config.json')
  }

  get cachePath(): string {
    return join(this.dir, 'cache.json')
  }

  async readConfig(): Promise<AppConfig> {
    const config = await readJson<AppConfig>(this.configPath, DEFAULT_CONFIG)
    return {
      version: 1,
      favorites: Array.isArray(config.favorites)
        ? config.favorites.filter((id): id is string => typeof id === 'string')
        : [],
      ...(config.settings && typeof config.settings === 'object'
        ? { settings: config.settings }
        : {})
    }
  }

  async readFavorites(): Promise<string[]> {
    return (await this.readConfig()).favorites
  }

  async readSettings(): Promise<AppSettings> {
    const config = await this.readConfig()
    return normalizeSettings(config.settings)
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.enqueueConfig(async () => {
      const config = await this.readConfig()
      const current = normalizeSettings(config.settings)
      const next = normalizeSettings({ ...current, ...patch })
      await writeJsonAtomic(this.configPath, {
        version: 1,
        favorites: config.favorites,
        settings: next
      } satisfies AppConfig)
      return next
    })
  }

  async setFavorite(sessionId: string, favorite: boolean): Promise<string[]> {
    return this.enqueueConfig(async () => {
      const config = await this.readConfig()
      const favorites = new Set(config.favorites)
      if (favorite) favorites.add(sessionId)
      else favorites.delete(sessionId)
      const next: AppConfig = {
        version: 1,
        favorites: [...favorites],
        ...(config.settings ? { settings: config.settings } : {})
      }
      await writeJsonAtomic(this.configPath, next)
      return next.favorites
    })
  }

  async removeFavorites(sessionIds: string[]): Promise<string[]> {
    return this.enqueueConfig(async () => {
      const config = await this.readConfig()
      const favorites = new Set(config.favorites)
      for (const sessionId of sessionIds) favorites.delete(sessionId)
      const next: AppConfig = {
        version: 1,
        favorites: [...favorites],
        ...(config.settings ? { settings: config.settings } : {})
      }
      await writeJsonAtomic(this.configPath, next)
      return next.favorites
    })
  }

  async readCache(): Promise<MetaCache> {
    const cache = await readJson<MetaCache>(this.cachePath, { version: 1, sessions: {} })
    const sessions =
      cache.sessions && typeof cache.sessions === 'object' ? cache.sessions : {}
    return { version: 1, sessions }
  }

  async writeCache(cache: MetaCache): Promise<void> {
    await writeJsonAtomic(this.cachePath, cache)
  }
}
