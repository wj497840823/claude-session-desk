export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatExecutable(executable: string): string {
  return executable.includes(' ') ? `"${executable}"` : executable
}

export function buildResumeCommand(
  projectPath: string,
  sessionId: string,
  executable = 'claude'
): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('非法会话 ID')
  }
  if (!projectPath || projectPath.includes('"')) {
    throw new Error('非法项目路径')
  }
  return `cd /d "${projectPath}" && ${formatExecutable(executable)} --resume ${sessionId}`
}

export function buildResumeSpawnArgs(
  sessionId: string,
  executable = 'claude'
): {
  file: string
  args: string[]
} {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('非法会话 ID')
  }
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: [
      '/c',
      'start',
      '',
      'cmd.exe',
      '/k',
      `${formatExecutable(executable)} --resume ${sessionId}`
    ]
  }
}