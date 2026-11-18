/**
 * Collaboration plumbing for one open project page.
 * - ONE HocuspocusProviderWebsocket per page; every doc is multiplexed over it.
 * - The project meta doc carries presence (awareness) and stateless events (MetaEvent).
 * - One HocuspocusProvider per open text file, attached to the shared socket.
 * Auth is the HttpOnly session cookie sent with the WebSocket upgrade; the token is ignored by the server.
 */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { fileDocName, metaDocName, type MetaEvent } from '@ligature/shared'
import { guardAwareness, peersFrom, type PresenceUser } from './presence.ts'

/** Yjs text key used by the server for file contents. */
export const TEXT_KEY = 'content'

export type { PresenceUser }

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface ProjectCollabHandlers {
  onStatus(status: ConnectionStatus): void
  onPeers(peers: PresenceUser[]): void
  onEvent(event: MetaEvent): void
  onAuthFailed(reason: string): void
}

export interface FileHandlers {
  /** Fires after the first (and every later) full sync with the server. */
  onSynced(): void
  onAuthFailed(reason: string): void
}

export interface FileSession {
  fileId: string
  epoch: number
  doc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  close(): void
}

function collabUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/collab`
}

function parseEvent(payload: string): MetaEvent | null {
  try {
    const e = JSON.parse(payload) as { type?: unknown } | null
    if (!e || typeof e !== 'object') return null
    if (e.type === 'tree-changed' || e.type === 'compile-finished' || e.type === 'access-revoked') return e as MetaEvent
  } catch {
    // ignore malformed payloads
  }
  return null
}

export class ProjectCollab {
  private readonly socket: HocuspocusProviderWebsocket
  private readonly meta: HocuspocusProvider
  private readonly files = new Set<FileSession>()
  private readonly projectId: string
  private readonly user: PresenceUser
  private destroyed = false

  constructor(projectId: string, user: PresenceUser, handlers: ProjectCollabHandlers) {
    this.projectId = projectId
    this.user = user
    this.socket = new HocuspocusProviderWebsocket({
      url: collabUrl(),
      onStatus: ({ status }) => { if (!this.destroyed) handlers.onStatus(status) },
    })
    this.meta = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: metaDocName(projectId),
      token: '',
      onStateless: ({ payload }) => {
        const e = parseEvent(payload)
        if (e && !this.destroyed) handlers.onEvent(e)
      },
      onAuthenticationFailed: ({ reason }) => { if (!this.destroyed) handlers.onAuthFailed(reason) },
      onAwarenessChange: ({ states }) => { if (!this.destroyed) handlers.onPeers(peersFrom(states)) },
    })
    this.meta.awareness?.setLocalStateField('user', user)
    this.meta.attach()
    handlers.onStatus(this.socket.status)
  }

  openFile(fileId: string, epoch: number, handlers: FileHandlers): FileSession {
    if (this.destroyed) throw new Error('ProjectCollab is destroyed')
    const doc = new Y.Doc()
    let closed = false
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: fileDocName(this.projectId, fileId, epoch),
      document: doc,
      token: '',
      onSynced: ({ state }) => { if (state && !closed) handlers.onSynced() },
      onAuthenticationFailed: ({ reason }) => { if (!closed) handlers.onAuthFailed(reason) },
    })
    const awareness = provider.awareness
    if (!awareness) throw new Error('provider has no awareness')
    // Before attach() and before the editor subscribes: remote user fields are sanitized first.
    const unguard = guardAwareness(awareness)
    awareness.setLocalStateField('user', this.user)
    provider.attach()

    const ytext = doc.getText(TEXT_KEY)
    const undoManager = new Y.UndoManager(ytext)
    const session: FileSession = {
      fileId, epoch, doc, ytext, awareness, undoManager,
      close: () => {
        if (closed) return
        closed = true
        this.files.delete(session)
        undoManager.destroy()
        unguard()
        provider.destroy() // detaches from the shared socket; does not close it
        doc.destroy()
      },
    }
    this.files.add(session)
    return session
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const f of [...this.files]) f.close()
    this.meta.destroy()
    this.socket.destroy()
  }
}
