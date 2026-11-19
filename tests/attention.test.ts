import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../src/renderer/src/store'

beforeEach(() => {
  useStore.setState(useStore.getInitialState())
})

describe('attention tracking', () => {
  it('tracks completed and approval sessions independently', () => {
    const store = useStore.getState()
    store.setAttention('s1', 'completed')
    store.setAttention('s2', 'approval')
    expect(useStore.getState().attention).toEqual({
      s1: 'completed',
      s2: 'approval'
    })
    store.setAttention('s1', null)
    expect(useStore.getState().attention).toEqual({ s2: 'approval' })
  })

  it('clears attention for a session when its terminal starts or closes', () => {
    const store = useStore.getState()
    store.startTerminal({
      key: 'tab-1',
      cwd: 'E:/demo',
      sessionId: 's1',
      projectName: 'demo',
      kind: 'resume',
      mode: 'follow'
    })
    store.setAttention('s1', 'completed')
    expect(useStore.getState().attention).toEqual({ s1: 'completed' })
    store.startTerminal({
      key: 'tab-1',
      cwd: 'E:/demo',
      sessionId: 's1',
      projectName: 'demo',
      kind: 'resume',
      mode: 'follow'
    })
    expect(useStore.getState().attention).toEqual({})
    store.setAttention('s1', 'approval')
    store.closeTerminal('tab-1')
    expect(useStore.getState().attention).toEqual({})
  })

  it('can clear every pending attention marker at once', () => {
    const store = useStore.getState()
    store.setAttention('s1', 'completed')
    store.setAttention('s2', 'approval')
    store.clearAllAttention()
    expect(useStore.getState().attention).toEqual({})
  })
})