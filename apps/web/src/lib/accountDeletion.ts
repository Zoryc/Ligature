/**
 * What the account deletion dialogs say (docs/ACCOUNT-DELETION.md): the server's AccountDeletionPreview
 * turned into sentences and lists. Pure, so every case can be unit-tested; the Account page renders the
 * self view with links, the admin page puts the admin text in a confirmation dialog.
 */
import type { AccountDeletionPreview, AccountDeletionResult, DeletionProject } from '@ligature/shared'
import { FORMER_MEMBER, personName } from './people.ts'
import { plural } from './storage.ts'

/** Shown last in both dialogs. */
export const CANNOT_UNDO = 'This cannot be undone.'

/** Why deletion cannot go ahead, with the projects to fix first (links on the Account page). */
export interface DeletionBlocked {
  state: 'blocked'
  reason: 'owns-shared-projects' | 'last-admin'
  text: string
  projects: DeletionProject[]
}

/** What self-deletion would do: the projects deleted (listed under `deletedText`), then plain notes. */
export interface DeletionReady {
  state: 'ready'
  deletedText: string
  deleted: DeletionProject[]
  notes: string[]
}

export type SelfDeletionView = DeletionBlocked | DeletionReady

const quoted = (s: string) => `“${s}”`

/** The Account page's dialog: blocked (and why), or what deleting your own account does. */
export function selfDeletionView(p: AccountDeletionPreview): SelfDeletionView {
  if (p.blocked === 'last-admin') {
    return {
      state: 'blocked', reason: 'last-admin', projects: [],
      text: 'You are the only active administrator of this server. Make another account an administrator '
        + '(Administration, Users) first, then come back here.',
    }
  }
  if (p.blocked === 'owns-shared-projects' || p.sharedOwned.length > 0) {
    const n = p.sharedOwned.length
    return {
      state: 'blocked', reason: 'owns-shared-projects', projects: p.sharedOwned.map(({ id, name }) => ({ id, name })),
      text: `You own ${n === 1 ? 'a project' : n > 1 ? `${n} projects` : 'projects'} that other people are members of. Open `
        + `${n === 1 ? 'it' : 'each one'} and transfer ownership to another member in Members first, then come back here.`,
    }
  }
  const d = p.deletedProjects.length
  return {
    state: 'ready',
    deletedText: d === 0 ? 'You own no projects, so none is deleted.'
      : `${d === 1 ? 'This project has' : `These ${d} projects have`} no other members and ${d === 1 ? 'is' : 'are'} deleted with your account:`,
    deleted: p.deletedProjects,
    notes: [
      p.leftProjects === 0 ? 'You are not a member of anyone else’s project.'
        : `You leave ${plural(p.leftProjects, 'project')} shared with you.`,
      `What you wrote in other people’s projects stays there, shown as ${quoted(FORMER_MEMBER)}.`,
      'Your username becomes free for a new account.',
    ],
  }
}

/** Lists in the admin dialog's text are cut after this many lines ("… and 3 more"). */
const MAX_LISTED = 8

function bullets(lines: string[]): string[] {
  const shown = lines.length > MAX_LISTED ? lines.slice(0, MAX_LISTED - 1) : lines
  const rest = lines.length - shown.length
  return [...shown.map(l => `• ${l}`), ...(rest > 0 ? [`• … and ${rest} more`] : [])]
}

/** The admin page's dialog: null when deletion is allowed, else why not (a toast). */
export function adminDeletionBlocked(p: AccountDeletionPreview): string | null {
  // Projects with other members do not block an admin deletion: their ownership is handed over.
  return p.blocked === 'last-admin'
    ? 'This is the only active administrator: make another account an administrator before deleting it.'
    : null
}

/** The toast after an admin deleted an account (the counts when the server sent them). */
export function adminDeletedText(username: string, r: AccountDeletionResult | null): string {
  const done = `Deleted the account ${username}.`
  if (!r) return done
  const parts = [
    r.projectsDeleted ? `${plural(r.projectsDeleted, 'project')} deleted` : '',
    r.ownershipTransferred ? `${plural(r.ownershipTransferred, 'project')} handed over` : '',
  ].filter(Boolean)
  return parts.length ? `${done} ${parts.join(', ')}.` : done
}

/** The admin dialog's message (shown with line breaks kept): what deleting this account does. */
export function adminDeletionText(p: AccountDeletionPreview, user: { username: string; displayName: string }): string {
  const out = [`Delete the account ${user.username} (${user.displayName})? They are logged out everywhere immediately.`, '']
  if (p.deletedProjects.length > 0) {
    out.push(`Deleted with it (no other members): ${plural(p.deletedProjects.length, 'project')}`)
    out.push(...bullets(p.deletedProjects.map(x => x.name)))
  } else out.push('No project is deleted with it.')
  if (p.sharedOwned.length > 0) {
    // The server's rule (successor() in deleteAccount.ts): editors before viewers, then who joined first.
    out.push('Ownership passes to the longest-standing editor (or viewer, if there is no editor):')
    out.push(...bullets(p.sharedOwned.map(x => `${x.name} → ${personName(x.newOwner.displayName)}`)))
  }
  if (p.leftProjects > 0) out.push(`They leave ${plural(p.leftProjects, 'project')} shared with them.`)
  out.push('', `Their edits in other people’s projects stay, shown as ${quoted(FORMER_MEMBER)}. `
    + `The username becomes free for a new account. ${CANNOT_UNDO}`)
  return out.join('\n')
}
