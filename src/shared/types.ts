export type TitleSource = 'ai-title' | 'first-prompt' | 'fallback'
export type SessionSource = 'transcript' | 'history'
export type TerminalPermissionMode =
  | 'follow'
  | 'manual'
  | 'auto'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
export type AppTheme = 'system' | 'light' | 'dark'
export type SessionClickAction = 'continue' | 'record'

export interface AppSettings {
  loadHistory: boolean
  minimizeToTray: boolean
  theme: AppTheme
  defaultPermissionMode: TerminalPermissionMode
  terminalFontSize: number
  sessionClickAction: SessionClickAction
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  loadHistory: false,
  minimizeToTray: true,
  theme: 'system',
  defaultPermissionMode: 'follow',
  terminalFontSize: 13,
  sessionClickAction: 'continue'
}

export interface TerminalStartOptions {
  cwd: string
  sessionId?: string | null
  newSessionId?: string
  mode: TerminalPermissionMode
  cols: number
  rows: number
}

export interface TerminalStartResult {
  ok: boolean
  message?: string
  ptyId?: string
  cwd?: string
}

export interface TerminalDataEvent {
  ptyId: string
  data: string
}

export interface TerminalExitEvent {
  ptyId: string
  exitCode: number
  signal?: number
}

export interface PastedContent {
  id: number
  content: string
}

export interface HistoryPrompt {
  index: number
  display: string
  timestamp: number
  pastedContents: PastedContent[]
}

export interface HistoryDetail {
  key: string
  id: string
  title: string
  projectPath: string
  createdAt: number
  updatedAt: number
  prompts: HistoryPrompt[]
}

export interface ProjectSummary {
  key: string
  name: string
  path: string
  sessionCount: number
  transcriptCount: number
  historyCount: number
  lastActivity: number
}

export interface SessionSummary {
  key: string
  id: string
  projectKey: string
  projectPath: string
  title: string
  titleSource: TitleSource
  createdAt: number
  updatedAt: number
  messageCount: number
  sizeBytes: number
  favorite: boolean
  cwdExists: boolean
  hasSidecar: boolean
  source: SessionSource
  promptCount: number
}

export interface Snapshot {
  projects: ProjectSummary[]
  sessions: SessionSummary[]
  scannedAt: number
  skippedFiles: number
  dataRoot: string
  dataRootExists: boolean
  historyFileExists: boolean
  transcriptCount: number
  historyOnlyCount: number
  settings: AppSettings
}

export interface ToolCall {
  id: string
  name: string
  inputSummary: string
  input: string
  result?: string
  isError?: boolean
  persistedOutputPath?: string
  files?: string[]
}

export interface FileContext {
  sessionId?: string
  sessionKey?: string
}

export interface Attachment {
  id: string
  name: string
  path: string
  size: number
  kind: 'image' | 'file'
  preview?: string
}

export interface ClipboardPaste {
  attachments: Attachment[]
  text?: string
}

export type SessionEvent =
  | { kind: 'user'; uuid: string; timestamp: number; text: string }
  | { kind: 'assistant'; uuid: string; timestamp: number; text: string; model?: string }
  | { kind: 'tools'; uuid: string; timestamp: number; calls: ToolCall[] }

export interface SessionDetail {
  key: string
  id: string
  title: string
  projectPath: string
  createdAt: number
  updatedAt: number
  events: SessionEvent[]
  totalEvents: number
  skippedLines: number
}

export interface SearchHit {
  sessionKey: string
  title: string
  projectName: string
  projectPath: string
  updatedAt: number
  snippet: string
  matchUuid: string
  source: SessionSource
  matchPromptIndex?: number
}

export interface SearchResponse {
  query: string
  hits: SearchHit[]
  truncated: boolean
  cancelled?: boolean
}

export interface ActionResult {
  ok: boolean
  message?: string
  command?: string
  path?: string
}

export interface BatchDeleteResult extends ActionResult {
  deletedKeys: string[]
  failedKeys: string[]
}

export interface ClaudeViewApi {
  pickAttachments(context: FileContext): Promise<Attachment[]>
  attachDroppedFiles(context: FileContext, files: unknown[]): Promise<Attachment[]>
  pasteClipboard(context: FileContext): Promise<ClipboardPaste>
  listAttachments(context: FileContext): Promise<Attachment[]>
  removeAttachments(context: FileContext, ids: string[]): Promise<Attachment[]>
  fileAction(context: FileContext, reference: string, action: 'open' | 'reveal' | 'check'): Promise<ActionResult>
  checkFileReferences(context: FileContext, references: string[]): Promise<ActionResult[]>
  getSnapshot(): Promise<Snapshot>
  refresh(): Promise<Snapshot>
  getSessionDetail(sessionKey: string): Promise<SessionDetail>
  getHistoryDetail(sessionKey: string): Promise<HistoryDetail>
  search(query: string, requestId: number): Promise<SearchResponse>
  setFavorite(sessionKey: string, favorite: boolean): Promise<string[]>
  resumeSession(sessionKey: string): Promise<ActionResult>
  deleteSession(sessionKey: string): Promise<ActionResult>
  deleteSessions(sessionKeys: string[]): Promise<BatchDeleteResult>
  deleteHistorySessions(sessionKeys: string[]): Promise<ActionResult>
  exportSession(sessionKey: string): Promise<ActionResult>
  openProjectFolder(projectKey: string): Promise<ActionResult>
  openProjectTerminal(projectKey: string): Promise<ActionResult>
  deleteProjectSessions(projectKey: string): Promise<ActionResult>
  openExternalPath(path: string): Promise<ActionResult>
  openFolder(path: string): Promise<ActionResult>
  pickFolder(): Promise<ActionResult>
  startTerminal(options: TerminalStartOptions): Promise<TerminalStartResult>
  writeTerminal(ptyId: string, data: string): Promise<void>
  resizeTerminal(ptyId: string, cols: number, rows: number): Promise<void>
  stopTerminal(ptyId: string): Promise<void>
  onTerminalData(callback: (event: TerminalDataEvent) => void): () => void
  onTerminalExit(callback: (event: TerminalExitEvent) => void): () => void
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  onDataChanged(callback: () => void): () => void
}
