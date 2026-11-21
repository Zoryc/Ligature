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
import { trackDoc, type LocalState } from './recovery.ts'
import { stampUndoItems } from './projectOps.ts'
import { SharedDocs } from './sharedDocs.ts'

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
  /** Was a Y.Doc update with this origin made here (typing, undo) rather than received from the server? */
  isLocal(origin: unknown): boolean
  /** The text now, and whether it holds edits the server has not acknowledged (docs/M3.md §4 recovery). */
  localState(): LocalState
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

/** What the provider of a shared doc tells its holders. */
interface DocListener {
  synced(): void
  authFailed(reason: string): void
  /** The server closed the doc; `reason` is a CloseReason when it gave a known one. */
  serverClosed(reason: unknown): void
}

/** A file's doc on the shared socket, as SharedDocs holds it. */
interface LiveDoc {
  doc: Y.Doc
  ytext: Y.Text
  provider: HocuspocusProvider
  awareness: Awareness
  serverClosed: ServerClosedState
  listeners: Set<DocListener>
  unguard: () => void
}

/** A file's live doc held for a project operation: no presence (docs/RENAME-AND-REPLACE.md §2). */
export interface FileHold {
  fileId: string
  ytext: Y.Text
  /** Resolves true once the doc is synced with the server; false after `ms`, or if the server closes or refuses it. */
  synced(ms: number): Promise<boolean>
  /** The server closed or refused the doc since it was held: the file has left the operation. */
  left(): boolean
  /** Let go; a doc with edits made here that the server has not acknowledged yet stays open until it has. */
  release(): void
}

export class ProjectCollab {
  private readonly socket: HocuspocusProviderWebsocket
  private readonly meta: HocuspocusProvider
  private readonly metaClosed: ServerClosedState
  private readonly files = new Set<FileSession>()
  private readonly docs: SharedDocs<LiveDoc>
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
    this.docs = new SharedDocs<LiveDoc>({
      open: name => this.openDoc(name),
      close: live => {
        live.listeners.clear()
        live.unguard()
        live.serverClosed.destroy(live.provider) // detaches from the shared socket; does not close it
        live.doc.destroy()
      },
      // Set before the provider is attached (openFile, holdFile), so the first sync sends the right state.
      presence: (live, on) => { live.awareness.setLocalState(on ? { user: this.user } : null) },
    })
    handlers.onStatus(this.socket.status)
  }

  /** A file's doc and its provider, not attached yet; without presence until a holder wants it. */
  private openDoc(name: string): LiveDoc {
    const doc = new Y.Doc()
    const listeners = new Set<DocListener>()
    const serverClosed = new ServerClosedState(this.socket)
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name,
      document: doc,
      token: '',
      onSynced: ({ state }) => {
        if (!state) return
        // Synced again without reauth(): the socket reconnected and re-authenticated every doc on it, this one
        // included. It is open on the server again; re-send our presence, if any, past the clock the close bumped.
        if (serverClosed.closed) {
          serverClosed.closed = false
          const aw = provider.awareness
          if (aw?.getLocalState()) bumpPresence(aw)
        }
        for (const l of [...listeners]) l.synced()
      },
      onAuthenticationFailed: ({ reason }) => { for (const l of [...listeners]) l.authFailed(reason) },
      onClose: ({ event }) => {
        if (!isServerClose(event)) return
        serverClosed.closed = true
        const reason = (event as { reason?: unknown }).reason
        for (const l of [...listeners]) l.serverClosed(reason)
      },
    })
    const awareness = provider.awareness
    if (!awareness) throw new Error('provider has no awareness')
    // Before attach() and before the editor subscribes: remote user fields are sanitized first.
    const unguard = guardAwareness(awareness)
    awareness.setLocalState(null)
    return { doc, ytext: doc.getText(TEXT_KEY), provider, awareness, serverClosed, listeners, unguard }
  }

  /**
   * Open a file for the editor, with presence. If a project operation holds its doc already, that doc is used
   * (and `onSynced` follows at once when it is synced).
   */
  openFile(fileId: string, epoch: number, handlers: FileHandlers): FileSession {
    if (this.destroyed) throw new Error('ProjectCollab is destroyed')
    let closed = false
    const hold = this.docs.acquire(fileDocName(this.projectId, fileId, epoch), true)
    const { doc, ytext, provider, awareness, serverClosed } = hold.value
    const listener: DocListener = {
      synced: () => { if (!closed) handlers.onSynced() },
      authFailed: reason => { if (!closed) handlers.onAuthFailed(reason) },
      serverClosed: reason => { if (!closed && isCloseReason(reason)) handlers.onClosed(reason) },
    }
    hold.value.listeners.add(listener)
    provider.attach()
    // Held by an operation, and closed by the server meanwhile (e.g. role-changed): ask again, as a fresh open would.
    if (serverClosed.closed) {
      bumpPresence(awareness)
      serverClosed.reauth(provider)
    }

    // The file's own undo: local typing only (never a project operation's edits, which have their own origin).
    const undoManager = new Y.UndoManager(ytext)
    const unstamp = stampUndoItems(undoManager)
    // Which edits the server has acknowledged (see SyncTracker for why not provider.hasUnsyncedChanges).
    const tracker = trackDoc(doc, ytext, provider)
    const onUnsynced = ({ number }: { number: number }) => { if (number === 0) tracker.acknowledged() }
    provider.on('unsyncedChanges', onUnsynced)
    if (provider.synced) {
      if (provider.unsyncedChanges === 0) tracker.acknowledged()
      queueMicrotask(() => listener.synced())
    }
    const session: FileSession = {
      fileId, epoch, doc, ytext, awareness, undoManager,
      isLocal: origin => origin !== provider,
      localState: () => tracker.state(ytext.toString()),
      reconnect: () => {
        if (closed) return
        if (serverClosed.closed) bumpPresence(awareness)
        serverClosed.reauth(provider)
      },
      close: () => {
        if (closed) return
        closed = true
        this.files.delete(session)
        hold.value.listeners.delete(listener)
        provider.off('unsyncedChanges', onUnsynced)
        tracker.stop()
        unstamp()
        undoManager.destroy()
        hold.release()
      },
    }
    this.files.add(session)
    return session
  }

  /**
   * Hold a file's live doc for a project operation, without presence. The file open in the editor shares its
   * doc; a doc held only here closes when released.
   */
  holdFile(fileId: string, epoch: number): FileHold {
    if (this.destroyed) throw new Error('ProjectCollab is destroyed')
    const hold = this.docs.acquire(fileDocName(this.projectId, fileId, epoch), false)
    const { doc, provider, awareness, serverClosed } = hold.value
    let left = false
    let released = false
    /** Edits were made here while held (the operation, its undo): see release. */
    let dirty = false
    let waiter: ((ok: boolean) => void) | null = null
    const leave = () => {
      left = true
      waiter?.(false)
    }
    const listener: DocListener = { synced: () => waiter?.(true), authFailed: leave, serverClosed: leave }
    hold.value.listeners.add(listener)
    const onUpdate = (_update: Uint8Array, origin: unknown) => { if (origin !== provider) dirty = true }
    doc.on('update', onUpdate)
    provider.attach()
    // A doc held already (by an earlier operation, or the editor) that the server closed meanwhile, e.g.
    // role-changed: ask for it again, as openFile does, or it would never sync.
    if (serverClosed.closed) {
      if (awareness.getLocalState()) bumpPresence(awareness)
      serverClosed.reauth(provider)
    }
    /**
     * Let go of the doc, but not before the server has the edits made here: offline, they wait in the socket's
     * queue, and a doc closed now would never be authenticated again to receive them. Released at once when
     * there are none, or when the server closed or refused the doc (they cannot reach it then).
     */
    const letGo = () => {
      doc.off('update', onUpdate)
      if (!dirty || left || serverClosed.closed || provider.unsyncedChanges === 0) {
        hold.release()
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        provider.off('unsyncedChanges', onUnsynced)
        hold.value.listeners.delete(flushed)
        hold.release()
      }
      const onUnsynced = ({ number }: { number: number }) => { if (number === 0) finish() }
      const flushed: DocListener = { synced: () => { if (provider.unsyncedChanges === 0) finish() }, authFailed: finish, serverClosed: finish }
      provider.on('unsyncedChanges', onUnsynced)
      hold.value.listeners.add(flushed)
    }
    return {
      fileId,
      ytext: hold.value.ytext,
      synced: ms => new Promise<boolean>(resolve => {
        if (left || released) return resolve(false)
        if (provider.synced && !serverClosed.closed) return resolve(true)
        const timer = setTimeout(() => waiter?.(false), ms)
        waiter = ok => {
          clearTimeout(timer)
          waiter = null
          resolve(ok)
        }
      }),
      left: () => left || released,
      release: () => {
        if (released) return
        released = true
        waiter?.(false)
        hold.value.listeners.delete(listener)
        letGo()
      },
    }
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
    this.docs.closeAll() // docs still held by project operations
    this.metaClosed.destroy(this.meta)
    this.socket.destroy()
  }
}
