import { Hocuspocus, type Document } from '@hocuspocus/server'
import { can, metaDocName, parseDocName, type MetaEvent, type Role } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import { readCookie, SESSION_COOKIE, userForToken, type SessionUser } from '../auth/sessions.ts'
import { getFile, roleOf } from '../projects/repo.ts'
import { DocStore, LOAD_ORIGIN } from './docStore.ts'

export interface CollabContext { user: SessionUser; role: Role; projectId: string }

/** Thrown from onAuthenticate; Hocuspocus sends `reason` to the provider as permission-denied. */
class Denied extends Error {
  constructor(public reason: string) { super(reason) }
}

function userIdOfOrigin(origin: unknown): string | null {
  const o = origin as { source?: string; connection?: { context?: Partial<CollabContext> } } | null
  return o?.source === 'connection' ? (o.connection?.context?.user?.id ?? null) : null
}

export function createCollab(db: DB, store: DocStore) {
  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'ligature',
    quiet: true,
    debounce: 2000,
    maxDebounce: 10000,
    yDocOptions: { gc: true, gcFilter: () => true },

    async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
      // Cookie auth: the WebSocket upgrade is same-origin and carries the HttpOnly session cookie.
      // (Origin is checked at the upgrade, before Hocuspocus sees the socket.) The provider's token is ignored.
      const user = userForToken(db, readCookie(requestHeaders.get('cookie'), SESSION_COOKIE))
      if (!user) throw new Denied('unauthenticated')

      const ref = parseDocName(documentName)
      if (!ref) throw new Denied('bad-document')

      const role = roleOf(db, ref.projectId, user.id)
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
      return { user, role, projectId: ref.projectId } satisfies CollabContext
    },

    /**
     * Presence is client-controlled data, so the server stamps the identity: every awareness state a
     * connection sends gets `user.id` / `user.name` from that connection's session. Nobody can appear
     * as someone else. Colours are recomputed client-side from the id. Oversized states are rejected.
     */
    async beforeHandleAwareness({ states, connection }) {
      const ctx = connection?.context
      if (!ctx) return // server-internal (DirectConnection)
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
      if (parseDocName(documentName)?.kind !== 'file') return
      if (clientsCount === 0 || store.shouldCompact(documentName)) store.compact(documentName, document)
      else store.flush()
    },

    async beforeUnloadDocument({ document, documentName }) {
      if (parseDocName(documentName)?.kind !== 'file') return
      store.compact(documentName, document)
    },

    async afterUnloadDocument({ documentName }) {
      store.release(documentName)
    },
  })

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

    /** Persist everything and stop. Called on SIGTERM/SIGINT. */
    async shutdown(): Promise<void> {
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
