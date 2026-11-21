/**
 * Display logic of the admin audit log (docs/M4.md §2): one plain sentence per action, said of the person
 * in the "who" column ("changed the compiler of Demo paper from pdfLaTeX to XeLaTeX"). Pure, so every
 * action can be unit-tested. Detail shapes are those of the server's audit() call sites.
 */
import type { AuditCategory, AuditEntryView } from '@ligature/shared'
import { engineLabel } from './engines.ts'
import { plural } from './storage.ts'

/** A piece of a sentence: plain text, a name (project or person, set in italics) or a file path (mono). */
export type AuditPart = string | { name: string } | { file: string }

/** Filter options, in the order of the select. '' = every category. */
export const CATEGORY_OPTIONS: readonly { value: AuditCategory | ''; label: string }[] = [
  { value: '', label: 'All activity' },
  { value: 'account', label: 'Accounts and sign-in' },
  { value: 'admin', label: 'Administration' },
  { value: 'members', label: 'Members and invites' },
  { value: 'projects', label: 'Projects and files' },
  { value: 'history', label: 'History' },
]

export type AuditPeriod = '24h' | '7d' | '30d' | 'all'

const DAY = 24 * 60 * 60 * 1000
export const PERIOD_OPTIONS: readonly { value: AuditPeriod; label: string; ms: number | null }[] = [
  { value: '24h', label: 'Last 24 hours', ms: DAY },
  { value: '7d', label: 'Last 7 days', ms: 7 * DAY },
  { value: '30d', label: 'Last 30 days', ms: 30 * DAY },
  { value: 'all', label: 'All time', ms: null },
]

/** The `since` filter of a period, or undefined for all time. */
export function periodSince(period: AuditPeriod, now: number): number | undefined {
  const ms = PERIOD_OPTIONS.find(p => p.value === period)?.ms ?? null
  return ms === null ? undefined : Math.max(0, now - ms)
}

/* ---- names ---- */

const DELETED_ACCOUNT = 'a deleted account'
const DELETED_PROJECT = 'a deleted project'

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const name = (n: string): AuditPart => ({ name: n })
const file = (f: string): AuditPart => ({ file: f })

/** Who did it, for the "who" column. */
export function actorLabel(e: AuditEntryView): string {
  if (e.actor === null) return e.action === 'login-failure' ? 'Someone' : 'Server'
  return e.actor.displayName || e.actor.username || 'A deleted account'
}

/** A person named in the detail (by display name), as of now. */
function person(e: AuditEntryView, id: unknown): string {
  const p = typeof id === 'string' ? e.users[id] : undefined
  return p ? (p.displayName || p.username) : DELETED_ACCOUNT
}

/** An account named in the detail, by username (account administration is about usernames). */
function account(e: AuditEntryView, id: unknown, recorded?: unknown): string {
  const p = typeof id === 'string' ? e.users[id] : undefined
  return p?.username || str(recorded) || DELETED_ACCOUNT
}

/** The project's current name. */
function project(e: AuditEntryView): string {
  return e.project?.name || DELETED_PROJECT
}

/** The project's name as the entry recorded it (create, delete, purge), else its current name. */
function recordedProject(e: AuditEntryView): string {
  return str(e.detail?.name) ?? project(e)
}

const isSelf = (e: AuditEntryView, id: unknown) => e.actor !== null && id === e.actor.id

/** "an editor", "a viewer", "an owner". */
function aRole(role: unknown): string {
  const r = str(role) ?? 'member'
  return /^[aeiou]/.test(r) ? `an ${r}` : `a ${r}`
}

const REGISTRATION: Record<string, string> = { 'invite-only': 'Invite only', open: 'Open', closed: 'Closed' }
const registration = (v: unknown) => {
  const r = str((v as { registration?: unknown } | null)?.registration)
  return r ? REGISTRATION[r] ?? r : '?'
}

/** A local date and time for a sentence (e.g. a version without a label). */
export function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Announced (polite live region) after "Load older": the new rows are otherwise silent for a screen reader. */
export function olderLoadedText(n: number, more: boolean): string {
  const loaded = n === 0 ? 'No older entries.' : `Loaded ${n} older ${n === 1 ? 'entry' : 'entries'}.`
  return more || n === 0 ? loaded : `${loaded} These are the oldest.`
}

/* ---- sentences ---- */

type Sentence = (e: AuditEntryView, d: Record<string, unknown>) => AuditPart[]

const viaCli = (d: Record<string, unknown>) => (d.via === 'cli' ? ' from the command line' : '')

function adminUserUpdate(e: AuditEntryView, d: Record<string, unknown>): AuditPart[] {
  const who = name(account(e, d.userId))
  if (d.via === 'cli') return ['reset the password of ', who, ' from the command line']
  const changes: string[] = []
  const display = str(d.displayName)
  if (display !== null) changes.push(`display name set to “${display}”`)
  if (d.isAdmin === true) changes.push('made an administrator')
  if (d.isAdmin === false) changes.push('administrator rights removed')
  if (d.disabled === true) changes.push('disabled')
  if (d.disabled === false) changes.push('enabled')
  if (d.passwordReset === true) changes.push('password reset')
  if (changes.length === 1) {
    if (d.disabled === true) return ['disabled the account ', who]
    if (d.disabled === false) return ['enabled the account ', who]
    if (d.isAdmin === true) return ['made ', who, ' an administrator']
    if (d.isAdmin === false) return ['removed administrator rights from ', who]
    if (d.passwordReset === true) return ['reset the password of ', who]
    return ['renamed the account ', who, ` to “${display}”`]
  }
  if (changes.length === 0) return ['saved the account ', who, ' without changes']
  return ['changed the account ', who, `: ${changes.join(', ')}`]
}

/**
 * account.delete (docs/ACCOUNT-DELETION.md): the entry keeps no name, so the account is never named; with
 * by 'self' the actor is the deleted account itself ("A deleted account" in the who column).
 */
function accountDelete(_e: AuditEntryView, d: Record<string, unknown>): AuditPart[] {
  const counts: [unknown, string, string][] = [
    [d.projectsDeleted, 'project', 'deleted'],
    [d.ownershipTransferred, 'project', 'handed over'],
    [d.projectsLeft, 'shared project', 'left'],
  ]
  const what = counts.flatMap(([v, one, verb]) => {
    const n = num(v)
    return n ? [`${plural(n, one)} ${verb}`] : []
  })
  return [`${d.by === 'self' ? 'deleted their own account' : 'deleted an account'}${what.length ? ` (${what.join(', ')})` : ''}`]
}

function gcRun(_e: AuditEntryView, d: Record<string, unknown>): AuditPart[] {
  const counts: [unknown, string, string][] = [
    [d.blobsRemoved, 'unreferenced blob', 'removed'],
    [d.orphanDocsRemoved, 'orphaned document', 'removed'],
    [d.versionsThinned, 'old automatic version', 'thinned'],
    [d.projectsPurged, 'deleted project', 'purged'],
  ]
  const what = counts.flatMap(([v, one, verb]) => {
    const n = num(v)
    return n ? [`${plural(n, one)} ${verb}`] : []
  })
  const run = d.trigger === 'schedule' ? 'ran the scheduled garbage collection' : 'ran the garbage collection'
  return [`${run}${what.length ? `: ${what.join(', ')}` : ' (nothing to remove)'}`]
}

function projectSetting(e: AuditEntryView, d: Record<string, unknown>): AuditPart[] {
  const from = str(d.from), to = str(d.to) ?? '?'
  if (d.key === 'name') return ['renamed ', name(from ?? DELETED_PROJECT), ' to ', name(to)]
  if (d.key === 'engine') return ['changed the compiler of ', name(project(e)), ` from ${engineLabel(from ?? '?')} to ${engineLabel(to)}`]
  if (d.key === 'mainFile') {
    return from === null ? ['set the main file of ', name(project(e)), ' to ', file(to)]
      : ['changed the main file of ', name(project(e)), ' from ', file(from), ' to ', file(to)]
  }
  return ['changed a setting of ', name(project(e))]
}

/** " (5 files and folders)" for a folder, '' for a single file. */
function items(count: unknown): string {
  const n = num(count)
  return n !== null && n > 1 ? ` (${n} files and folders)` : ''
}

function versionRestore(e: AuditEntryView, d: Record<string, unknown>): AuditPart[] {
  const label = str(d.label)
  const at = num(d.versionAt)
  const target = label !== null ? `“${label}”` : at !== null ? `the version of ${formatWhen(at)}` : 'an earlier version'
  const paths = Array.isArray(d.paths) ? d.paths : null
  if (paths) return [`restored ${plural(paths.length, 'file')} of `, name(project(e)), ` from ${target}`]
  return ['restored ', name(project(e)), ` to ${target}`]
}

const SENTENCES: Record<string, Sentence> = {
  // accounts and sign-in
  'signup': (_e, d) => ['signed up as ', name(str(d.username) ?? '?'),
    `${d.admin === true ? ' (the first account: administrator)' : ''}${str(d.project) ? ' with an invite link' : ''}`],
  'login': (_e, d) => [d.dev === true ? 'logged in (development login)' : 'logged in'],
  'login-failure': (e, d) => ['failed to log in as ', name(str(d.username) ?? '?'),
    d.reason === 'disabled' ? ' (account disabled)' : e.actor === null ? ' (no such account)' : ' (wrong password)'],
  'logout-all': (_e, d) => {
    if (d.reason !== 'password-change') return ['logged out everywhere']
    const n = num(d.sessions) ?? 0
    return [n > 0 ? `changed their password and ended ${plural(n, 'other session')}` : 'changed their password']
  },

  // administration
  'admin-user-create': (e, d) => ['created the account ', name(account(e, d.userId, d.username)),
    `${d.isAdmin === true ? ' (administrator)' : ''}${viaCli(d)}`],
  'admin-user-update': adminUserUpdate,
  'account.delete': accountDelete,
  'settings-update': (_e, d) => {
    const before = registration(d.before), after = registration(d.after)
    return [before === after ? `saved the registration setting (“${after}”)` : `changed registration from “${before}” to “${after}”`]
  },
  'storage.view': () => ['viewed the storage report'],
  'gc.run': gcRun,
  'doc.rebuild': (e, d) => [d.reason === 'oversized' ? 'rebuilt an oversized document in ' : 'rebuilt a document of ', name(project(e))],
  'project.purge': e => ['permanently removed the deleted project ', name(recordedProject(e))],
  'backup.restore': (_e, d) => {
    const at = Date.parse(str(d.backupCreatedAt) ?? '')
    return [`restored the whole instance from ${Number.isNaN(at) ? 'a backup' : `the backup of ${formatWhen(at)}`}${viaCli(d)}`]
  },

  // members and invites
  'member-add': (e, d) => isSelf(e, d.userId) ? ['joined ', name(project(e)), ` as ${aRole(d.role)}`]
    : ['added ', name(person(e, d.userId)), ' to ', name(project(e)), ` as ${aRole(d.role)}`],
  'member-role-change': (e, d) => isSelf(e, d.userId)
    ? [`became ${aRole(d.to)} of `, name(project(e)), `${str(d.inviteId) ? ' with an invite link' : ''} (was ${aRole(d.from)})`]
    : ['changed the role of ', name(person(e, d.userId)), ' in ', name(project(e)), ` from ${str(d.from) ?? '?'} to ${str(d.to) ?? '?'}`],
  'member-remove': (e, d) => d.left === true || isSelf(e, d.userId) ? ['left ', name(project(e))]
    : ['removed ', name(person(e, d.userId)), ' from ', name(project(e))],
  'ownership-transfer': (e, d) => isSelf(e, d.from) || d.from === undefined
    ? ['transferred ownership of ', name(project(e)), ' to ', name(person(e, d.to))]
    : ['transferred ownership of ', name(project(e)), ' from ', name(person(e, d.from)), ' to ', name(person(e, d.to))],
  'invite-create': (e, d) => {
    const uses = num(d.maxUses)
    return [`created ${aRole(d.role)} invite link for `, name(project(e)),
      uses === null ? '' : uses === 1 ? ' (single use)' : ` (up to ${uses} uses)`]
  },
  'invite-revoke': e => ['revoked an invite link of ', name(project(e))],
  'invite-accept': (e, d) => [`accepted ${aRole(d.role)} invite link to `, name(project(e))],

  // projects and files
  'project-create': (e, d) => {
    if (d.import !== true) return ['created ', name(recordedProject(e))]
    const files = num(d.files), skipped = num(d.skipped)
    const counts = files === null ? '' : ` (${plural(files, 'file')}${skipped ? `, ${skipped} skipped` : ''})`
    return ['imported ', name(recordedProject(e)), ` from a zip file${counts}`]
  },
  'project-delete': e => ['deleted ', name(recordedProject(e))],
  'project.setting': projectSetting,
  'file-delete': (e, d) => ['deleted ', file(str(d.name) ?? '?'), ' in ', name(project(e)), items(d.count)],
  'file.restore': (e, d) => ['restored ', file(str(d.name) ?? '?'), ' in ', name(project(e)), ` from the trash${items(d.count)}`],
  'file.purge': (e, d) => d.reason === 'expired'
    ? [`permanently deleted ${plural(num(d.count) ?? 0, 'expired trash item')} of `, name(project(e))]
    : ['permanently deleted ', file(str(d.name) ?? '?'), ' from the trash of ', name(project(e)), items(d.count)],
  'trash.empty': (e, d) => ['emptied the trash of ', name(project(e)), ` (${plural(num(d.count) ?? 0, 'item')})`],

  // history
  'version.create': (e, d) => {
    const label = str(d.label)
    return label !== null ? [`saved the version “${label}” of `, name(project(e))] : ['saved a version of ', name(project(e))]
  },
  'version.label': (e, d) => {
    const label = str(d.label)
    return label !== null ? ['named a version of ', name(project(e)), ` “${label}”`] : ['removed the name of a version of ', name(project(e))]
  },
  'version.restore': versionRestore,
}

/** The sentence of an entry as parts (names marked); unknown actions fall back to the action name. */
export function auditParts(e: AuditEntryView): AuditPart[] {
  const s = Object.hasOwn(SENTENCES, e.action) ? SENTENCES[e.action] : undefined
  const parts = s ? s(e, e.detail ?? {}) : [e.action]
  return parts.filter(p => p !== '')
}

/** The sentence as plain text (tests, titles). */
export function auditSentence(e: AuditEntryView): string {
  return auditParts(e).map(p => (typeof p === 'string' ? p : 'name' in p ? p.name : p.file)).join('')
}

/** Failed logins and deletions carry a red mark. */
export function isAlarming(e: AuditEntryView): boolean {
  switch (e.action) {
    case 'login-failure': case 'account.delete': case 'project-delete': case 'project.purge':
    case 'file-delete': case 'file.purge': case 'trash.empty':
      return true
    case 'member-remove':
      return e.detail?.left !== true && !isSelf(e, e.detail?.userId)
    default:
      return false
  }
}

/** The recorded details as key/value lines for the expanded row; people ids get their name. */
export function detailLines(e: AuditEntryView): { key: string; value: string }[] {
  return Object.entries(e.detail ?? {}).map(([key, v]) => {
    let value = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
    const p = typeof v === 'string' ? e.users[v] : undefined
    if (p) value += ` (${p.username})`
    return { key, value }
  })
}
