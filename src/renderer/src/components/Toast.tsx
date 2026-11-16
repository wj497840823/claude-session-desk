import { useEffect } from 'react'
import { useStore } from '../store'

export default function Toast(): React.JSX.Element | null {
  const toast = useStore((state) => state.toast)
  const clearToast = useStore((state) => state.clearToast)

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(clearToast, 3000)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  if (!toast) return null
  return <div className={`toast ${toast.kind}`}>{toast.message}</div>
}