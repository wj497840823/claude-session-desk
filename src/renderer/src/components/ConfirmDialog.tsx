export default function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  danger = false,
  onCancel,
  onConfirm
}: {
  title: string
  message: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const dialogRef = useDialog(true, onCancel)
  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}
        tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        <div>{message}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
import { useDialog } from '../lib/useDialog'

