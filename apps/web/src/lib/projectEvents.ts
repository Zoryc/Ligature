/**
 * What the project page should do when something happens on the collaboration socket:
 * a MetaEvent on the meta doc, a per-document CLOSE from the server (with a reason), or a failed
 * (re)authentication. Pure, so it can be unit-tested; Project.svelte executes the actions.
 */
import type { MetaEvent } from '@ligature/shared'

/** Parse a stateless payload from the meta doc; null for anything malformed or unknown. */
export function parseMetaEvent(payload: string): MetaEvent | null {
  let e: Record<string, unknown>
  try {
    const v = JSON.parse(payload) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    e = v as Record<string, unknown>
  } catch {
    return null
  }
  switch (e['type']) {
    case 'tree-changed':
      return typeof e['treeVersion'] === 'number' ? { type: 'tree-changed', treeVersion: e['treeVersion'] } : null
    case 'project-changed':
    case 'members-changed':
    case 'project-deleted':
    case 'trash-changed':
      return { type: e['type'] }
    case 'compile-finished': {
      const { buildId, status } = e
      if (typeof buildId !== 'string' || !['success', 'failure', 'timeout', 'error'].includes(status as string)) return null
      return { type: 'compile-finished', buildId, status: status as 'success' }
    }
    case 'access-revoked':
      return typeof e['userId'] === 'string' ? { type: 'access-revoked', userId: e['userId'] } : null
    default:
      return null
  }
}

export type ProjectAction =
  /** Refetch the project (tree, role, name, main file). */
  | { type: 'refresh-project' }
  /** Drop a user's presence (their access was revoked). */
  | { type: 'drop-peer'; userId: string }
  /** Refetch the trash listing (its count is shown under the file tree). */
  | { type: 'refresh-trash' }
  /** Refetch the member list (only when the members panel is open). */
  | { type: 'refresh-members' }
  /** Hand the build event to BuildEvents. */
  | { type: 'compile-finished'; buildId: string; status: string }
  /** Refetch the project: if we still have access, continue (maybe read-only) with `notice`; else leave with `leave`. */
  | { type: 'recheck-access'; notice: string; leave: string }
  /** Leave the project page for the project list with a notice. */
  | { type: 'leave'; notice: string }
  /** The session is gone: notice and back to the login page (or recheck the session). */
  | { type: 'session-lost'; notice: string }
  /** Reconnect our documents (role changed: the server re-reads the role on authentication). */
  | { type: 'reconnect'; notice: string }
  /** The open file was deleted: close it. */
  | { type: 'file-gone'; notice: string }
  /** The server closed the open file's connection because our role changed: re-authenticate it. */
  | { type: 'file-reconnect' }
  /** The open file's doc was reset (epoch changed): refetch the tree and reopen it. */
  | { type: 'file-reload' }

export interface EventContext {
  meId: string
  /** treeVersion of the project we currently show. */
  treeVersion: number
  membersOpen: boolean
}

const REMOVED = 'You were removed from this project.'
const DELETED = 'This project was deleted.'
export const SESSION_ENDED = 'Your session ended (logged out elsewhere, or the password was changed).'

/**
 * The meta doc (re)synced with the server: after the first connection, or after the socket came back
 * from an outage. MetaEvents sent while we were away are lost, so refetch what they would have updated.
 */
export function resyncActions(ctx: Pick<EventContext, 'membersOpen'>): ProjectAction[] {
  return [{ type: 'refresh-project' }, { type: 'refresh-trash' }, ...(ctx.membersOpen ? [{ type: 'refresh-members' } as const] : [])]
}

export function metaEventActions(e: MetaEvent, ctx: EventContext): ProjectAction[] {
  switch (e.type) {
    case 'tree-changed':
      return e.treeVersion !== ctx.treeVersion ? [{ type: 'refresh-project' }] : []
    case 'project-changed':
      return [{ type: 'refresh-project' }]
    case 'members-changed':
      return ctx.membersOpen ? [{ type: 'refresh-members' }] : []
    case 'compile-finished':
      return [{ type: 'compile-finished', buildId: e.buildId, status: e.status }]
    case 'access-revoked':
      return e.userId === ctx.meId
        ? [{ type: 'recheck-access', notice: 'Your access to this project changed.', leave: REMOVED }]
        : [{ type: 'drop-peer', userId: e.userId }, ...(ctx.membersOpen ? [{ type: 'refresh-members' } as const] : [])]
    case 'project-deleted':
      return [{ type: 'leave', notice: DELETED }]
    case 'trash-changed':
      return [{ type: 'refresh-trash' }]
  }
}

/** Scope of a closed/denied document: the project meta doc or one text file. */
export type DocScope = 'meta' | 'file'

/** The server's per-document CLOSE reasons (apps/server/src/collab/collab.ts CloseReason). */
export const CLOSE_REASONS = ['access-revoked', 'role-changed', 'project-deleted', 'file-deleted', 'account-disabled', 'session-ended'] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]

export function isCloseReason(r: unknown): r is CloseReason {
  return typeof r === 'string' && (CLOSE_REASONS as readonly string[]).includes(r)
}

/**
 * A document was closed by the server. Each user connection to the project (meta + open file) gets
 * its own CLOSE, so project-wide reasons are acted on from the meta doc only.
 */
export function closeActions(reason: CloseReason, scope: DocScope): ProjectAction[] {
  if (scope === 'file') {
    // Neutral wording: the deletion may have come from this very tab.
    if (reason === 'file-deleted') return [{ type: 'file-gone', notice: 'The open file was moved to the trash.' }]
    // Re-authenticating picks up the new role (read-only or not); a no-op if access is gone (the meta doc handles that).
    return reason === 'role-changed' ? [{ type: 'file-reconnect' }] : []
  }
  switch (reason) {
    case 'access-revoked':
      return [{ type: 'recheck-access', notice: 'Your access to this project changed.', leave: REMOVED }]
    case 'role-changed':
      return [{ type: 'reconnect', notice: 'Your role in this project changed.' }]
    case 'project-deleted':
      return [{ type: 'leave', notice: DELETED }]
    case 'account-disabled':
      return [{ type: 'session-lost', notice: 'Your account was disabled.' }]
    case 'session-ended':
      // Our own "Log out" tears the socket down first, so this is another tab/device or a password change.
      return [{ type: 'session-lost', notice: SESSION_ENDED }]
    case 'file-deleted':
      return []
  }
}

/** (Re)authentication of a document failed with `reason` (apps/server onAuthenticate Denied reasons). */
export function authFailedActions(reason: string, scope: DocScope): ProjectAction[] {
  switch (reason) {
    case 'unauthenticated':
      return [{ type: 'session-lost', notice: 'Your session has expired. Log in again.' }]
    case 'forbidden':
      return [{ type: 'recheck-access', notice: 'Your access to this project changed.', leave: 'You no longer have access to this project.' }]
    case 'not-found':
    case 'file-deleted':
      return scope === 'file'
        ? [{ type: 'file-gone', notice: 'This file no longer exists.' }]
        : [{ type: 'leave', notice: 'This project no longer exists.' }]
    case 'reload-required':
      return scope === 'file' ? [{ type: 'file-reload' }] : [{ type: 'refresh-project' }]
    default:
      return scope === 'file'
        ? [{ type: 'file-gone', notice: `Cannot open this file (${reason}).` }]
        : [{ type: 'recheck-access', notice: `Connection refused (${reason}).`, leave: 'You no longer have access to this project.' }]
  }
}
