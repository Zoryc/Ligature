/**
 * Presence (awareness) states come from other clients and are relayed by the server unchecked.
 * Never trust them: colours end up in style attributes (ours and y-codemirror's), names in the UI.
 */
import type { Awareness } from 'y-protocols/awareness'
import { userColor } from './colors.ts'

export interface PresenceUser { id: string; name: string; color: string; colorLight: string }

const MAX_ID = 128
const MAX_NAME = 64

/**
 * Clean up a remote `user` field. The colour is always recomputed from the id (every client derives
 * the same colour from the same id), so a remote client cannot inject CSS. Returns null if unusable.
 */
export function sanitizeUser(raw: unknown): PresenceUser | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as { id?: unknown; name?: unknown }
  if (typeof u.id !== 'string' || u.id === '' || u.id.length > MAX_ID) return null
  // Drop control characters; cap the length so a name cannot take over the top bar.
  const name = typeof u.name === 'string' ? u.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) : ''
  return { id: u.id, name: name || 'Anonymous', ...userColor(u.id) }
}

/**
 * Rewrite every remote state's `user` in place with its sanitized form, so later readers
 * (y-codemirror's caret/selection decorations, our peer list) only ever see safe values.
 * Unusable users are replaced by an anonymous grey placeholder.
 */
export function sanitizeRemoteStates(awareness: Awareness): void {
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID || !state || typeof state !== 'object') continue
    const clean = sanitizeUser(state['user'])
    state['user'] = clean ?? { id: '', name: 'Anonymous', color: '#888888', colorLight: '#88888833' }
  }
}

/**
 * Keep an awareness instance sanitized. Must be called right after the awareness is created and
 * BEFORE anything else (y-codemirror) subscribes: lib0 observers run in subscription order, so our
 * handler rewrites the new states before any other 'change' handler reads them.
 * Returns an unsubscribe function.
 */
export function guardAwareness(awareness: Awareness): () => void {
  const handler = () => sanitizeRemoteStates(awareness)
  awareness.on('change', handler)
  awareness.on('update', handler)
  return () => {
    awareness.off('change', handler)
    awareness.off('update', handler)
  }
}

/** Peers for the top bar: sanitized, one entry per user id, sorted by name. */
export function peersFrom(states: Iterable<Record<string, unknown>>): PresenceUser[] {
  const byId = new Map<string, PresenceUser>()
  for (const s of states) {
    const u = sanitizeUser(s['user'])
    if (u) byId.set(u.id, u)
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}
