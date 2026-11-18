/**
 * Collaboration plumbing for one open project page.
 * - ONE HocuspocusProviderWebsocket per page; every doc is multiplexed over it.
 * - The project meta doc carries presence (awareness) and stateless events (MetaEvent).
 * - One HocuspocusProvider per open text file, attached to the shared socket.
 * Auth is the HttpOnly session cookie sent with the WebSocket upgrade; the token is ignored by the server.
 */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { removeAwarenessStates, type Awareness } from 'y-protocols/awareness'
import { fileDocName, metaDocName, type MetaEvent } from '@ligature/shared'
import { isCloseReason, parseMetaEvent, type CloseReason } from './projectEvents.ts'
import { guardAwareness, peersFrom, type PresenceUser } from './presence.ts'

/** Yjs text key used by the server for file contents. */
export const TEXT_KEY = 'content'

export type { PresenceUser }

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface ProjectCollabHandlers {
  onStatus(status: ConnectionStatus): void
  onPeers(peers: PresenceUser[]): void
  onEvent(event: MetaEvent): void
  /**
   * The meta doc finished a sync: on the first connection and again after every reconnect (socket
   * outage, re-authentication). Events sent while we were disconnected are lost; refetch on this.
   */
  onSynced(): void
  onAuthFailed(reason: string): void
  /** The server closed our meta doc connection (role change, removal, project deletion, ...). */
  onClosed(reason: CloseReason): void
}

export interface FileHandlers {
  /** Fires after the first (and every later) full sync with the server. */
  onSynced(): void
  onAuthFailed(reason: string): void
  /** The server closed this file's connection (e.g. file-deleted, role-changed). */
  onClosed(reason: CloseReason): void
}

export interface FileSession {
  fileId: string
  epoch: number
  doc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  /** Re-authenticate after the server closed this doc (e.g. role-changed); keeps the Y.Doc. No-op otherwise. */
  reconnect(): void
  close(): void
}

function collabUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/collab`
}

/**
 * Server-side CLOSE messages reach the provider's onClose as a plain {code, reason} object; a closing
 * socket passes a real CloseEvent (and the provider re-authenticates by itself when the socket reopens).
 */
function isServerClose(event: unknown): boolean {
  return !!event && typeof event === 'object' && !(typeof CloseEvent !== 'undefined' && event instanceof CloseEvent)
}

/**
 * Tracks whether the server closed a provider's document connection, and re-authenticates it in place.
 * Re-attaching (detach + attach) must be avoided: detach sends a CLOSE for the doc, the server queues it
 * (no connection for that doc any more) and replays it right after the next authentication, closing the
 * new connection at once. The same applies to destroying a provider the server already closed.
 */
class ServerClosedState {
  closed = false
  constructor(private readonly socket: HocuspocusProviderWebsocket) {}

  /** Re-run authentication + sync on the open socket (if the socket is down, it happens on reconnect). */
  reauth(provider: HocuspocusProvider): boolean {
    if (!this.closed) return false
    this.closed = false
    // When we were closed, the provider dropped peers' presence and bumped their clocks locally; the server
    // re-sends their states with the old clocks, which would be ignored as stale. Forget those clocks.
    const aw = provider.awareness
    if (aw) for (const id of [...aw.meta.keys()]) if (id !== aw.clientID && !aw.states.has(id)) aw.meta.delete(id)
    if (this.socket.status === 'connected') void provider.onOpen(new Event('open'))
    return true
  }

  /** Destroy without sending a CLOSE for a doc the server already closed (see above). */
  destroy(provider: HocuspocusProvider): void {
    if (this.closed && this.socket.configuration.providerMap.get(provider.effectiveName) === provider) {
      this.socket.configuration.providerMap.delete(provider.effectiveName)
    }
    provider.destroy()
  }
}

/**
 * When the server closes a doc it removes our awareness state, which bumps our clock on its side by one.
 * Re-sending our state with a clock at most equal would be ignored as stale (and the server would not
 * register it to the new connection, so it would linger after we leave). Bump it by two.
 */
function bumpPresence(awareness: Awareness): void {
  const state = awareness.getLocalState()
  awareness.setLocalState(state)
  awareness.setLocalState(state)
}

export class ProjectCollab {
  private readonly socket: HocuspocusProviderWebsocket
  private readonly meta: HocuspocusProvider
  private readonly metaClosed: ServerClosedState
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
    const metaClosed = new ServerClosedState(this.socket)
    this.metaClosed = metaClosed
    this.meta = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: metaDocName(projectId),
      token: '',
      onSynced: ({ state }) => { if (state && !this.destroyed) handlers.onSynced() },
      onStateless: ({ payload }) => {
        const e = parseMetaEvent(payload)
        if (e && !this.destroyed) handlers.onEvent(e)
      },
      onAuthenticationFailed: ({ reason }) => { if (!this.destroyed) handlers.onAuthFailed(reason) },
      // Per-document CLOSE from the server carries a reason; plain socket closes do not match a CloseReason.
      onClose: ({ event }) => {
        if (!isServerClose(event)) return
        metaClosed.closed = true
        const reason = (event as { reason?: unknown }).reason
        if (!this.destroyed && isCloseReason(reason)) handlers.onClosed(reason)
      },
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
    const serverClosed = new ServerClosedState(this.socket)
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: fileDocName(this.projectId, fileId, epoch),
      document: doc,
      token: '',
      onSynced: ({ state }) => { if (state && !closed) handlers.onSynced() },
      onAuthenticationFailed: ({ reason }) => { if (!closed) handlers.onAuthFailed(reason) },
      onClose: ({ event }) => {
        if (!isServerClose(event)) return
        serverClosed.closed = true
        const reason = (event as { reason?: unknown }).reason
        if (!closed && isCloseReason(reason)) handlers.onClosed(reason)
      },
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
      reconnect: () => {
        if (closed) return
        if (serverClosed.closed) bumpPresence(awareness)
        serverClosed.reauth(provider)
      },
      close: () => {
        if (closed) return
        closed = true
        this.files.delete(session)
        undoManager.destroy()
        unguard()
        serverClosed.destroy(provider) // detaches from the shared socket; does not close it
        doc.destroy()
      },
    }
    this.files.add(session)
    return session
  }

  /**
   * Re-authenticate the meta doc after the server closed it (e.g. role-changed): the server re-reads
   * our role, or denies us (onAuthFailed). The shared socket stays open.
   */
  reconnectMeta(): void {
    if (this.destroyed || !this.metaClosed.closed) return
    if (this.meta.awareness) bumpPresence(this.meta.awareness)
    this.metaClosed.reauth(this.meta)
  }

  /**
   * Forget a user's presence right away (their access was revoked; the server's own removal can lag
   * until the 30 s awareness timeout). Local only: origin = the provider, so nothing is sent.
   */
  dropPeer(userId: string): void {
    const aw = this.meta.awareness
    if (!aw || this.destroyed) return
    const ids: number[] = []
    aw.getStates().forEach((state, clientId) => {
      const user = (state as { user?: { id?: unknown } }).user
      if (clientId !== aw.clientID && user?.id === userId) ids.push(clientId)
    })
    if (ids.length) removeAwarenessStates(aw, ids, this.meta)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const f of [...this.files]) f.close()
    this.metaClosed.destroy(this.meta)
    this.socket.destroy()
  }
}
