import { describe, expect, it } from 'vitest'
import { externalWebUrl, isPathInside, parseSessionKey } from '../src/main/validation'

const SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('validation', () => {
  it('opens only web links outside the application', () => {
    expect(externalWebUrl('https://example.com/docs')).toBe('https://example.com/docs')
    for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'cmd:run', 'invalid']) {
      expect(externalWebUrl(url)).toBeNull()
    }
  })
  it('parses valid session keys', () => {
    expect(parseSessionKey(`E--demo/${SID}`)).toEqual({
      projectKey: 'E--demo',
      sessionId: SID
    })
  })

  it('rejects invalid session keys', () => {
    expect(parseSessionKey('../x/' + SID)).toBeNull()
    expect(parseSessionKey('E--demo/not-a-uuid')).toBeNull()
    expect(parseSessionKey(123)).toBeNull()
    expect(parseSessionKey(`E--demo/${SID}/extra`)).toBeNull()
  })

  it('checks that a path stays inside the data root', () => {
    expect(isPathInside('C:/data', 'C:/data/a/b.txt')).toBe(true)
    expect(isPathInside('C:/data', 'C:/other/b.txt')).toBe(false)
    expect(isPathInside('C:/data', 'C:/data/../secret.txt')).toBe(false)
    expect(isPathInside('C:/data', 'C:/data')).toBe(false)
  })
})
