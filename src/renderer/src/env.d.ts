/// <reference types="vite/client" />
import type { ClaudeViewApi } from '@shared/types'

declare global {
  interface Window {
    api: ClaudeViewApi
  }
}

export {}