import { Hocuspocus, type Connection, type Document } from '@hocuspocus/server'
import { can, metaDocName, parseDocName, type MetaEvent, type Role } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import { invalidSessionHashes, readCookie, SESSION_COOKIE, sessionForToken, type SessionUser } from '../auth/sessions.ts'
import { getFile, roleOf } from '../projects/repo.ts'
import { DocStore, LOAD_ORIGIN, TEXT_KEY } from './docStore.ts'
import { applyTextDiff } from './textDiff.ts'

export interface CollabContext { user: SessionUser; role: Role; projectId: string; sessionHash: string }

/** Reasons sent to the client in the per-document CLOSE message. */
export type CloseReason = 'access-revoked' | 'role-changed' | 'project-deleted' | 'file-deleted' | 'account-disabled' | 'session-ended'

/** Thrown from onAuthenticate; Hocuspocus sends `reason` to the provider as permission-denied. */
class Denied extends Error {
  constructor(public reason: string) { super(reason) }
}

function userIdOfOrigin(origin: unknown): string | null {
  const o = origin as { source?: string; connection?: { context?: Partial<CollabContext> }; context?: Partial<CollabContext> } | null
  if (o?.source === 'connection') return o.connection?.context?.user?.id ?? null
  if (o?.source === 'local') return o.context?.user?.id ?? null // server-originated edit (e.g. upload)
  return null
}

export interface CollabOptions {
  /** How often open connections are re-checked against their session (logout elsewhere, expiry, disable). */
  sessionCheckMs?: number
}

export function createCollab(db: DB, store: DocStore, opts: CollabOptions = {}) {
  /** The Yjs clientID whose presence each connection may set (see beforeHandleAwareness). */
  const awarenessClient = new WeakMap<Connection, number>()

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'ligature',
    quiet: true,
    // Messages queued per socket before a document's Auth completes (default 5 MB).
    maxUnauthenticatedQueueSize: 1024 * 1024,
    debounce: 2000,
    maxDebounce: 10000,
    yDocOptions: { gc: true, gcFilter: () => true },

    async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
      // Cookie auth: the WebSocket upgrade is same-origin and carries the HttpOnly session cookie.
      // (Origin is checked at the upgrade, before Hocuspocus sees the socket.) The provider's token is ignored.
      // sessionForToken rejects expired sessions and disabled users.
      const session = sessionForToken(db, readCookie(requestHeaders.get('cookie'), SESSION_COOKIE))
      if (!session) throw new Denied('unauthenticated')

      const ref = parseDocName(documentName)
      if (!ref) throw new Denied('bad-document')

      // roleOf only sees live (not deleted) projects.
      const role = roleOf(db, ref.projectId, session.user.id)
      if (!role) throw new Denied('forbidden')

      if (ref.kind === 'file') {
        const f = getFile(db, ref.fileId)
        if (!f || f.projectId !== ref.projectId || f.kind !== 'text' || f.deletedAt !== null) throw new Denied('not-found')
        if (f.epoch !== ref.epoch) throw new Denied('reload-required')
        connectionConfig.readOnly = !can.edit(role)
      } else {
        // The meta doc carries no content: only awareness (presence) and stateless events.
        connectionConfig.readOnly = true
      }
      return { user: session.user, role, projectId: ref.projectId, sessionHash: session.tokenHash } satisfies CollabContext
    },

    /**
     * Presence is client-controlled data, so the server stamps the identity: every awareness state a
     * connection sends gets `user.id` / `user.name` from that connection's session. Nobody can appear
     * as someone else. Colours are recomputed client-side from the id. Oversized states are rejected.
     */
    async beforeHandleAwareness({ states, removedClients, connection }) {
      const ctx = connection?.context
      if (!connection || !ctx) return // server-internal (DirectConnection)
      // A connection may only set or clear the presence of its own Yjs client: it is bound to the first
      // clientID it sends a state for. States and removals for any other clientID are dropped (a normal
      // client also sends removals of peers it timed out locally, so dropping is silent, not an error).
      let own = awarenessClient.get(connection)
      if (own === undefined) {
        const first = states.keys().next()
        if (!first.done) awarenessClient.set(connection, own = first.value)
      }
      for (const id of [...states.keys()]) if (id !== own) states.delete(id)
      for (const id of [...removedClients]) if (id !== own) removedClients.delete(id)
      for (const state of states.values()) {
        if (JSON.stringify(state).length > 4096) throw new Error('awareness state too large')
        state['user'] = { id: ctx.user.id, name: ctx.user.displayName }
      }
    },

    async onLoadDocument({ document, documentName }) {
      if (parseDocName(documentName)?.kind !== 'file') return
      store.load(documentName, document)
      // Log every later change synchronously, in the same tick it is applied.
      document.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === LOAD_ORIGIN) return
        store.append(documentName, update, userIdOfOrigin(origin))
      })
    },

    async onStoreDocument({ document, documentName, clientsCount }) {
      const ref = parseDocName(documentName)
      if (ref?.kind !== 'file' || !db.open) return
      if (clientsCount === 0 || store.shouldCompact(documentName)) store.compact(documentName, document)
      else store.flush()
      // Debounced (2–10 s), so this is cheap: keeps "most recently updated" project ordering meaningful.
      const now = Date.now()
      db.prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, ref.fileId)
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, ref.projectId)
    },

    async beforeUnloadDocument({ document, documentName }) {
      if (parseDocName(documentName)?.kind !== 'file' || !db.open) return
      store.compact(documentName, document)
    },

    async afterUnloadDocument({ documentName }) {
      store.release(documentName)
    },
  })

  /** Snapshot of the client connections matching `pred` (closing mutates the underlying maps). */
  function connections(pred: (docName: string, ctx: Partial<CollabContext>) => boolean): Connection[] {
    const out: Connection[] = []
    for (const [name, doc] of hocuspocus.documents) {
      for (const conn of doc.getConnections()) {
        if (pred(name, (conn.context ?? {}) as Partial<CollabContext>)) out.push(conn)
      }
    }
    return out
  }

  const inProject = (docName: string, projectId: string) => parseDocName(docName)?.projectId === projectId

  function closeAll(conns: Connection[], reason: CloseReason): number {
    for (const c of conns) c.close({ code: 4403, reason })
    return conns.length
  }

  function checkSessions(): number {
    if (!db.open) return 0
    const hashes = new Set<string>()
    connections((_, ctx) => { if (ctx.sessionHash) hashes.add(ctx.sessionHash); return false })
    if (hashes.size === 0) return 0
    const bad = invalidSessionHashes(db, hashes)
    if (bad.size === 0) return 0
    return closeAll(connections((_, ctx) => ctx.sessionHash !== undefined && bad.has(ctx.sessionHash)), 'session-ended')
  }
  const sessionTimer = setInterval(checkSessions, opts.sessionCheckMs ?? 60_000)
  sessionTimer.unref()

  return {
    hocuspocus,

    /** Live doc if loaded (authoritative), else undefined. */
    liveDoc(documentName: string): Document | undefined {
      return hocuspocus.documents.get(documentName)
    },

    /** Broadcast a project event to everyone who has the project open. */
    broadcast(projectId: string, event: MetaEvent): void {
      hocuspocus.documents.get(metaDocName(projectId))?.broadcastStateless(JSON.stringify(event))
    },

    /**
     * Close a user's connections — to one project, or to every project when `projectId` is null.
     * Their provider gets a CLOSE message with `reason`; a reconnect re-runs onAuthenticate,
     * which re-reads the role (or denies). `exceptSessionHash` keeps the connections of one session.
     */
    closeUserConnections(userId: string, projectId: string | null, reason: CloseReason, exceptSessionHash?: string): number {
      return closeAll(connections((name, ctx) =>
        ctx.user?.id === userId
        && (projectId === null || inProject(name, projectId))
        && (exceptSessionHash === undefined || ctx.sessionHash !== exceptSessionHash)), reason)
    },

    /** Close every connection authenticated with one session (logout). */
    closeSessionConnections(sessionHash: string, reason: CloseReason): number {
      return closeAll(connections((_, ctx) => ctx.sessionHash === sessionHash), reason)
    },

    /**
     * Close connections whose session is no longer valid: deleted (logout, CLI reset), expired, or
     * the user disabled. Runs periodically; returns the number of connections closed.
     */
    checkSessions,

    /** Close every connection to every doc of a project (project deleted). */
    closeProjectConnections(projectId: string, reason: CloseReason): number {
      return closeAll(connections(name => inProject(name, projectId)), reason)
    },

    /** Close every connection to one doc (file deleted). */
    closeDocConnections(docName: string, reason: CloseReason): number {
      return closeAll(connections(name => name === docName), reason)
    },

    /**
     * Compact a loaded doc now (durable immediately) and unload it as soon as Hocuspocus allows
     * (it unloads by itself once a pending debounced store has run). No-op if not loaded.
     */
    async unloadDoc(docName: string): Promise<void> {
      const doc = hocuspocus.documents.get(docName)
      if (!doc) return
      if (parseDocName(docName)?.kind === 'file') store.compact(docName, doc)
      // A debounced store would block the unload for up to `debounce` ms: run pending stores now.
      hocuspocus.flushPendingStores()
      for (let i = 0; i < 50 && hocuspocus.documents.get(docName) === doc; i++) {
        if (doc.getConnectionsCount() > 0) return // someone legitimately (re)connected meanwhile
        if (hocuspocus.shouldUnloadDocument(doc)) await hocuspocus.unloadDocument(doc)
        else await new Promise(r => setTimeout(r, 20))
      }
    },

    /**
     * Server-originated edit: make the doc's text equal `text` via a minimal diff, applied in one
     * transaction through a DirectConnection (origin = LocalTransactionOrigin, so the persistence
     * listener logs it, attributed to `userId`). Never replaces the Y.Doc: collaborators see an
     * ordinary edit and keep their cursors and undo stacks.
     */
    async replaceText(docName: string, text: string, userId: string | null): Promise<void> {
      const conn = await hocuspocus.openDirectConnection(docName, { user: { id: userId } } as unknown as CollabContext)
      try {
        await conn.transact(doc => {
          const ytext = doc.getText(TEXT_KEY)
          applyTextDiff(ytext, ytext.toString(), text)
        })
      } finally {
        await conn.disconnect()
      }
    },

    /** Persist everything and stop. Called on SIGTERM/SIGINT. */
    async shutdown(): Promise<void> {
      clearInterval(sessionTimer)
      hocuspocus.flushPendingStores()
      for (const [name, doc] of hocuspocus.documents) {
        if (parseDocName(name)?.kind === 'file') store.compact(name, doc)
      }
      store.flush()
      hocuspocus.closeConnections()
    },
  }
}

export type Collab = ReturnType<typeof createCollab>
