import { app, desktopCapturer, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Attachment, FileContext } from '@shared/types'
import type { FileService } from './files'

const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024

export async function captureScreenshot(
  context: FileContext,
  files: FileService
): Promise<Attachment[]> {
  const sessionId = context?.sessionId
  if (!sessionId || !/^[a-f\d-]{36}$/i.test(sessionId)) throw new Error('请先打开一个运行中的对话')

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.round(display.size.width * display.scaleFactor)
  const height = Math.round(display.size.height * display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取屏幕画面')
  const png = source.thumbnail.toPNG()
  if (png.length > MAX_SCREENSHOT_BYTES) throw new Error('截图超过 25 MB，请降低屏幕分辨率后重试')

  const directory = join(app.getPath('userData'), 'attachments', sessionId)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `截图-${randomUUID()}.png`)
  await writeFile(path, png, { flag: 'wx' })
  try {
    return await files.add(context, [path])
  } catch (error) {
    await unlink(path).catch(() => undefined)
    throw error
  }
}