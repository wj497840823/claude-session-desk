import { describe, expect, it } from 'vitest'
import { attachmentText, findFileReferences, parseFileReference } from '../src/shared/fileReferences'

describe('file references', () => {
  it('accepts local paths and locations but rejects executable URL schemes and control characters', () => {
    expect(parseFileReference('C:\\项目\\report.pdf:12:3')).toEqual({ path: 'C:\\项目\\report.pdf', line: 12, column: 3 })
    expect(parseFileReference('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 })
    expect(parseFileReference('app.ts:42')).toEqual({ path: 'app.ts', line: 42 })
    expect(parseFileReference('file:///C:/My%20Project/a.txt#L9')).toEqual({ path: 'C:/My Project/a.txt', line: 9 })
    for (const text of ['javascript:alert(1)', 'https://example.com/file.txt', 'file://remote/share/file.txt', 'bad\nfile.txt', 'file:///C:/bad%00file.txt']) {
      expect(parseFileReference(text)).toBeNull()
    }
  })

  it('detects Chinese and quoted space-containing paths without turning web URLs into local links', () => {
    const text = '输出 `E:/项目/报告 结果.pdf`，以及 src/main.ts:12:2 和 report.csv。https://example.com/report.pdf'
    const references = findFileReferences(text)
    expect(references.map((item) => item.reference)).toEqual(['E:/项目/报告 结果.pdf', 'src/main.ts:12:2', 'report.csv'])
    for (const item of references) expect(text.slice(item.start, item.end)).toBe(item.reference)
    expect(findFileReferences('version 1.1.0, example.com, person@example.com')).toEqual([])
  })

  it('quotes multiple attachments without injecting terminal control keys or submission', () => {
    const text = attachmentText(['C:\\My Files\\a.txt', 'E:/截图.png'])
    expect(text).toBe('"C:/My Files/a.txt" "E:/截图.png" ')
    expect(text).not.toMatch(/[\r\n]/)
    expect(() => attachmentText(['C:/a\rfile.txt'])).toThrow()
  })

  it('retains full unquoted Windows paths with spaces and strips Java line ranges', () => {
    expect(findFileReferences('结果 C:/My Project/报告 结果.pdf，确认后打开').map((item) => item.reference)).toEqual(['C:/My Project/报告 结果.pdf'])
    expect(parseFileReference('DownloadService.java:62-66')).toEqual({ path: 'DownloadService.java', line: 62 })
    expect(parseFileReference('file:///C:/My%20Project/a.txt#section')).toEqual({ path: 'C:/My Project/a.txt' })
    expect(findFileReferences('Throwable.getMessage() 和 Service.downloadFile()')).toEqual([])
  })
})
