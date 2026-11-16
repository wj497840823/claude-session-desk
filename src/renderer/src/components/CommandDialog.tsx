import { useState } from 'react'
import { useDialog } from '../lib/useDialog'

export default function CommandDialog({
  title,
  command,
  onClose
}: {
  title: string
  command: string
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const dialogRef = useDialog(true, onClose)

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}
        tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        <p>可以复制下面的命令，手动在项目目录的终端中执行：</p>
        <div className="command">{command}</div>
        <div className="dialog-actions">
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(command).then(() => setCopied(true))
            }}
          >
            {copied ? '已复制' : '复制命令'}
          </button>
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
