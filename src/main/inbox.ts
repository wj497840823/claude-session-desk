import type { InboxItem } from '@shared/types'
import type { ApprovalBroker } from './approvalBroker'
import type { ScheduledTaskService } from './scheduledTasks'

export function buildInbox(
  approvals: ApprovalBroker,
  tasks: ScheduledTaskService
): InboxItem[] {
  const approvalItems = approvals.list().map((request) => ({
    kind: 'approval' as const,
    ...request
  }))
  const askItems = tasks.asks()
  const taskItems = tasks.inbox()
  return [...approvalItems, ...askItems, ...taskItems].sort((left, right) => {
    const time = (item: InboxItem): number =>
      item.kind === 'approval'
        ? item.createdAt
        : item.kind === 'ask'
          ? item.askedAt
          : item.endedAt
    return time(right) - time(left)
  })
}