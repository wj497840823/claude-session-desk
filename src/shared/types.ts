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
  desktopNotifications: boolean
  terminalCopyOnSelect: boolean
  terminalRightClickPaste: boolean
  theme: AppTheme
  defaultPermissionMode: TerminalPermissionMode
  terminalFontSize: number
  sessionClickAction: SessionClickAction
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  loadHistory: false,
  minimizeToTray: true,
  desktopNotifications: true,
  terminalCopyOnSelect: true,
  terminalRightClickPaste: true,
  theme: 'system',
  defaultPermissionMode: 'follow',
  terminalFontSize: 13,
  sessionClickAction: 'continue'
}

export interface TerminalStartOptions {
  cwd: string
  sessionId?: string | null
  newSessionId?: string
  forkFromSessionId?: string
  title?: string
  mode: TerminalPermissionMode
  cols: number
  rows: number
}

export type TerminalActivity = 'working' | 'idle' | 'approval'

export interface TerminalActivityEvent {
  ptyId: string
  sessionId: string | null
  activity: TerminalActivity
}

export interface AttentionSummary {
  total: number
  completed: number
  approval: number
}

export type ScheduleSpec =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'interval'; minutes: number }

export type ScheduledTaskType = 'claude' | 'command'
export type ScheduledTaskRunStatus = 'success' | 'failed' | 'timeout' | 'cancelled'

export interface ScheduledTaskRun {
  id: string
  startedAt: number
  endedAt: number
  status: ScheduledTaskRunStatus
  exitCode?: number
  logPath: string
  outputTail: string
  sessionId?: string
}

export interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  projectPath: string
  type: ScheduledTaskType
  prompt?: string
  command?: string
  permissionMode?: TerminalPermissionMode
  model?: string
  maxBudgetUsd?: number
  sessionMode?: 'new' | 'resume' | 'existing'
  resumeSessionId?: string
  schedule: ScheduleSpec
  createdAt: number
  updatedAt: number
  nextRun?: number
  lastRun?: ScheduledTaskRun
  running?: boolean
}

export type ScheduledTaskInput = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'nextRun' | 'lastRun' | 'running'
>

export interface ScheduledTaskLog {
  run: ScheduledTaskRun
  content: string
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

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm?: string
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
  todos?: TodoItem[]
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

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SessionUsage extends TokenUsage {
  costUSD: number | null
  contextTokens: number
  contextLimit: number | null
  contextPercent: number | null
  model?: string
}

export type SessionEvent =
  | { kind: 'user'; uuid: string; timestamp: number; text: string }
  | { kind: 'assistant'; uuid: string; timestamp: number; text: string; model?: string; usage?: TokenUsage }
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
  getSessionUsage(sessionKey: string): Promise<SessionUsage | null>
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
  onTerminalActivity(callback: (event: TerminalActivityEvent) => void): () => void
  onFocusSession(callback: (sessionId: string) => void): () => void
  captureScreenshot(context: FileContext): Promise<Attachment[]>
  onScreenshotTrigger(callback: () => void): () => void
  updateAttention(summary: AttentionSummary): Promise<void>
  listScheduledTasks(): Promise<ScheduledTask[]>
  createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>
  updateScheduledTask(id: string, input: ScheduledTaskInput): Promise<ScheduledTask>
  deleteScheduledTask(id: string): Promise<void>
  setScheduledTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTask>
  runScheduledTask(id: string): Promise<ActionResult>
  cancelScheduledTask(id: string): Promise<ActionResult>
  listScheduledTaskRuns(id: string): Promise<ScheduledTaskRun[]>
  readScheduledTaskLog(id: string, runId: string): Promise<ScheduledTaskLog>
  onSchedulesChanged(callback: () => void): () => void
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  onDataChanged(callback: () => void): () => void
}
