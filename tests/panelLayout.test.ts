import { expect, it } from 'vitest'
import { fitPanelWidths } from '../src/renderer/src/lib/panelLayout'

it('keeps room for the workspace at the minimum window size', () => {
  const fitted = fitPanelWidths(960, 420, 640, false, false)
  expect(fitted.rail).toBeGreaterThanOrEqual(160)
  expect(fitted.list).toBeGreaterThanOrEqual(240)
  expect(960 - fitted.rail - fitted.list - 8).toBeGreaterThanOrEqual(300)
  expect(fitPanelWidths(1600, 420, 640, false, false)).toEqual({ rail: 420, list: 640 })
})

it('uses the available space when a panel is collapsed', () => {
  expect(fitPanelWidths(960, 420, 640, true, false)).toEqual({ rail: 0, list: 640 })
  expect(fitPanelWidths(960, 420, 640, false, true)).toEqual({ rail: 420, list: 0 })
})
