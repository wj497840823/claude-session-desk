import type { GitStatus } from '@shared/types'
import { useStore } from '../store'
import { chunkProjectKeys, gitErrorMessage } from './gitHelpers'

export { activeProjectKeys, chunkProjectKeys, gitErrorMessage } from './gitHelpers'

export async function refreshGitStatuses(projectKeys: string[]): Promise<void> {
  if (projectKeys.length === 0) return
  try {
    for (const chunk of chunkProjectKeys(projectKeys)) {
      const statuses = await window.api.getGitStatuses(chunk)
      useStore.getState().setGitStatuses(statuses)
    }
  } catch {
    // 徽章是尽力而为；具体错误在打开面板时展示。
  }
}

export async function refreshGitProject(
  projectKey: string,
  force = false
): Promise<GitStatus | null> {
  try {
    const status = await window.api.getGitStatus(projectKey, force)
    useStore.getState().setGitStatuses([status])
    return status
  } catch (error) {
    useStore.getState().showToast({
      kind: 'error',
      message: `读取 Git 状态失败：${gitErrorMessage(error)}`
    })
    return null
  }
}