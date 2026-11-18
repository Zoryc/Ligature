import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { guardAwareness, peersFrom, sanitizeUser } from '../src/lib/presence.ts'
import { userColor } from '../src/lib/colors.ts'

const EVIL = 'red; position: fixed; inset: 0; z-index: 9999; background: rgba(255,0,0,.4)'

describe('sanitizeUser', () => {
  it('ignores the remote colour and derives it from the id (review finding 1)', () => {
    const u = sanitizeUser({ id: 'carol', name: 'Carol', color: EVIL, colorLight: EVIL })
    expect(u).toEqual({ id: 'carol', name: 'Carol', ...userColor('carol') })
    expect(u!.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(u!.colorLight).toMatch(/^#[0-9a-f]{8}$/)
  })

  it('caps and cleans names, rejects unusable users', () => {
    expect(sanitizeUser({ id: 'x', name: 'a'.repeat(500) })!.name).toHaveLength(64)
    expect(sanitizeUser({ id: 'x', name: 'a\u0000b\nc' })!.name).toBe('abc')
    expect(sanitizeUser({ id: 'x', name: 42 })!.name).toBe('Anonymous')
    expect(sanitizeUser({ id: 7, name: 'n' })).toBeNull()
    expect(sanitizeUser({ id: '', name: 'n' })).toBeNull()
    expect(sanitizeUser('alice')).toBeNull()
    expect(sanitizeUser(null)).toBeNull()
  })
})

describe('peersFrom', () => {
  it('sanitizes, dedupes by id and sorts by name', () => {
    const peers = peersFrom([
      { user: { id: 'b', name: 'Bob', color: EVIL } },
      { user: { id: 'a', name: 'Alice' } },
      { user: { id: 'b', name: 'Bob', color: '#000000' } },
      {},
      { user: 'nope' },
    ])
    expect(peers.map(p => p.id)).toEqual(['a', 'b'])
    expect(peers.every(p => /^#[0-9a-f]{6}$/.test(p.color))).toBe(true)
  })
})

describe('guardAwareness', () => {
  it('rewrites remote states before later subscribers (y-codemirror) read them', () => {
    const local = new Awareness(new Y.Doc())
    const remote = new Awareness(new Y.Doc())
    try {
      const unguard = guardAwareness(local)
      const seen: string[] = []
      // Subscribed later, like y-codemirror's remote-selection plugin.
      local.on('change', () => {
        for (const [id, s] of local.getStates()) if (id !== local.clientID) seen.push(String(s['user']?.color))
      })
      remote.setLocalStateField('user', { id: 'carol', name: 'Alice (owner)', color: EVIL, colorLight: EVIL })
      applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), 'test')
      // A second, different malicious update.
      remote.setLocalStateField('user', { id: 'carol', name: 'Carol', color: `${EVIL}; color: blue` })
      applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), 'test')

      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every(c => c === userColor('carol').color)).toBe(true)
      const state = local.getStates().get(remote.clientID)
      expect(state?.['user']).toEqual({ id: 'carol', name: 'Carol', ...userColor('carol') })
      unguard()
    } finally {
      local.destroy()
      remote.destroy()
    }
  })
})
