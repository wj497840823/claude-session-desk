/// <reference lib="dom" />
import { expect, it } from 'vitest'
import type { Attachment } from '@shared/types'
import { addDraftFiles, emptyDraft, removeDraftFiles } from '../src/renderer/src/lib/attachmentDraft'

const file = (id: string, path: string): Attachment => ({ id, path, name: id, kind: 'file', size: 1 })

it('deduplicates copied paths and removes a reference while preserving the message', () => {
  const first = file('a', 'C:\\项目 空格\\需求.txt')
  const next = file('b', 'E:\\B.txt')
  let draft = addDraftFiles({ text: '请核查', files: [] }, [first, next])
  draft = addDraftFiles(draft, [file('duplicate', 'e:\\b.txt')])
  expect(draft.text).toBe('请核查 "C:/项目 空格/需求.txt" "E:/B.txt" ')
  expect(draft.files).toHaveLength(2)
  const removed = removeDraftFiles(draft, ['a'])
  expect(removed.text).not.toContain('需求.txt')
  expect(removed.text).toContain('请核查')
  expect(removed.text).toContain('"E:/B.txt"')
  expect(removed.files).toEqual([next])
})

it('clears the final path without leaving an attached file', () => {
  const removed = removeDraftFiles(addDraftFiles(emptyDraft(), [file('a', 'C:/a.txt')]), ['a'])
  expect(removed.text.trim()).toBe('')
  expect(removed.files).toEqual([])
})
