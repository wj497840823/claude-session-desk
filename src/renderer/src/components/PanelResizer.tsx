import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

export default function PanelResizer({
  value,
  min,
  max,
  defaultValue,
  onChange
}: {
  value: number
  min: number
  max: number
  defaultValue: number
  onChange: (width: number) => void
}): React.JSX.Element {
  const cleanupRef = useRef<() => void>(() => undefined)
  useEffect(() => () => cleanupRef.current(), [])
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    cleanupRef.current()
    event.preventDefault()
    const startX = event.clientX
    const startWidth = value
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    const onMove = (moveEvent: PointerEvent): void => {
      const next = Math.min(
        max,
        Math.max(min, startWidth + moveEvent.clientX - startX)
      )
      onChange(next)
    }
    const onUp = (): void => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      cleanupRef.current = () => undefined
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    cleanupRef.current = onUp
  }

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={(event) => {
        let next: number
        if (event.key === 'ArrowLeft') next = value - 16
        else if (event.key === 'ArrowRight') next = value + 16
        else if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        else return
        event.preventDefault()
        onChange(Math.min(max, Math.max(min, next)))
      }}
      title="拖动调整宽度，双击重置"
      onPointerDown={startResize}
      onDoubleClick={() => onChange(defaultValue)}
    />
  )
}
