import { useEffect, useRef } from 'react'

export function useDialog(open: boolean, onClose: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return undefined
    const previous = document.activeElement
    const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
    )).filter((element) => element.getClientRects().length > 0)
    ;(focusable()[0] ?? dialog).focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]')
      if (dialogs[dialogs.length - 1] !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
      } else if (event.key === 'Tab') {
        const items = focusable()
        const first = items[0] ?? dialog
        const last = items[items.length - 1] ?? dialog
        if (!dialog.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
