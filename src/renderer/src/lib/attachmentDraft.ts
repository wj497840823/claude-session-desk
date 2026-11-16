import type { Attachment } from '@shared/types'
import { attachmentText } from '@shared/fileReferences'

export interface AttachmentDraft { text: string; files: Attachment[] }
export const emptyDraft = (): AttachmentDraft => ({ text: '', files: [] })

export function addDraftFiles(draft: AttachmentDraft, files: Attachment[]): AttachmentDraft {
  const paths = new Set(draft.files.map((file) => file.path.toLowerCase()))
  const added = files.filter((file) => {
    const key = file.path.toLowerCase()
    if (paths.has(key)) return false
    paths.add(key)
    return true
  })
  return { text: draft.text + (added.length ? (draft.text && !/\s$/.test(draft.text) ? ' ' : '') + attachmentText(added.map((file) => file.path)) : ''),
    files: [...draft.files, ...added] }
}

export function removeDraftFiles(draft: AttachmentDraft, ids: string[]): AttachmentDraft {
  const removing = new Set(ids)
  let text = draft.text
  for (const file of draft.files) {
    if (removing.has(file.id)) text = text.replaceAll(attachmentText([file.path]).trimEnd(), '')
  }
  return { text: text.trim() ? text : '', files: draft.files.filter((file) => !removing.has(file.id)) }
}

export function loadDraft(sessionId: string | undefined): AttachmentDraft {
  if (!sessionId || typeof window === 'undefined') return emptyDraft()
  try {
    const value = JSON.parse(localStorage.getItem('csm.draft.' + sessionId) ?? 'null') as AttachmentDraft | null
    if (typeof value?.text === 'string' && Array.isArray(value.files) && value.files.every((file) =>
      file && typeof file.id === 'string' && typeof file.path === 'string' && typeof file.name === 'string')) return value
  } catch { /* A corrupt or unavailable local draft does not block the terminal. */ }
  return emptyDraft()
}

export function saveDraft(sessionId: string | undefined, draft: AttachmentDraft): boolean {
  if (!sessionId || typeof window === 'undefined') return true
  try {
    const key = 'csm.draft.' + sessionId
    if (!draft.text.trim() && !draft.files.length) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(draft))
    return true
  } catch { return false }
}
