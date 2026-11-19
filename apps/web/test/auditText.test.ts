import { describe, expect, it } from 'vitest'
import { AUDIT_CATEGORIES, type AuditEntryView, type AuditPerson } from '@ligature/shared'
import {
  actorLabel, auditParts, auditSentence, CATEGORY_OPTIONS, detailLines, formatWhen, isAlarming, olderLoadedText, PERIOD_OPTIONS,
  periodSince,
} from '../src/lib/auditText.ts'

const ALICE: AuditPerson = { id: 'u-alice', username: 'alice', displayName: 'Alice Admin' }
const BOB: AuditPerson = { id: 'u-bob', username: 'bob', displayName: 'Bob Builder' }
const PROJECT = { id: 'p-1', name: 'Demo paper', deleted: false }

/** An entry by Alice on Demo paper, with Bob known as a named user. */
function entry(action: string, detail: Record<string, unknown> | null, over: Partial<AuditEntryView> = {}): AuditEntryView {
  return { id: 1, at: 0, action, category: null, actor: ALICE, project: PROJECT, detail, users: { [BOB.id]: BOB, [ALICE.id]: ALICE }, ...over }
}
const say = (action: string, detail: Record<string, unknown> | null, over: Partial<AuditEntryView> = {}) =>
  auditSentence(entry(action, detail, over))

describe('audit sentences: accounts and sign-in', () => {
  it('signup', () => {
    expect(say('signup', { username: 'alice', admin: false, project: null }, { project: null })).toBe('signed up as alice')
    expect(say('signup', { username: 'alice', admin: true, project: null })).toBe('signed up as alice (the first account: administrator)')
    expect(say('signup', { username: 'alice', admin: false, project: 'p-1' })).toBe('signed up as alice with an invite link')
  })

  it('login', () => {
    expect(say('login', { ip: '10.0.0.1' })).toBe('logged in')
    expect(say('login', { ip: '10.0.0.1', dev: true })).toBe('logged in (development login)')
  })

  it('login-failure', () => {
    expect(say('login-failure', { username: 'bob', ip: '10.0.0.1' }, { actor: BOB })).toBe('failed to log in as bob (wrong password)')
    expect(say('login-failure', { username: 'bob', ip: '10.0.0.1', reason: 'disabled' }, { actor: BOB }))
      .toBe('failed to log in as bob (account disabled)')
    const unknown = entry('login-failure', { username: 'mallory', ip: '10.0.0.1' }, { actor: null })
    expect(auditSentence(unknown)).toBe('failed to log in as mallory (no such account)')
    expect(actorLabel(unknown)).toBe('Someone') // not "Server": somebody typed it
  })

  it('logout-all', () => {
    expect(say('logout-all', { reason: 'password-change', sessions: 2 })).toBe('changed their password and ended 2 other sessions')
    expect(say('logout-all', { reason: 'password-change', sessions: 1 })).toBe('changed their password and ended 1 other session')
    expect(say('logout-all', { reason: 'password-change', sessions: 0 })).toBe('changed their password')
    expect(say('logout-all', null)).toBe('logged out everywhere')
  })
})

describe('audit sentences: administration', () => {
  it('admin-user-create', () => {
    expect(say('admin-user-create', { userId: BOB.id, username: 'bob', isAdmin: false })).toBe('created the account bob')
    expect(say('admin-user-create', { userId: BOB.id, username: 'bob', isAdmin: true })).toBe('created the account bob (administrator)')
    expect(say('admin-user-create', { userId: 'u-x', username: 'root', isAdmin: true, via: 'cli' }, { actor: null }))
      .toBe('created the account root (administrator) from the command line')
  })

  it('admin-user-update', () => {
    const upd = (d: Record<string, unknown>) => say('admin-user-update', { userId: BOB.id, passwordReset: false, ...d })
    expect(upd({ disabled: true })).toBe('disabled the account bob')
    expect(upd({ disabled: false })).toBe('enabled the account bob')
    expect(upd({ isAdmin: true })).toBe('made bob an administrator')
    expect(upd({ isAdmin: false })).toBe('removed administrator rights from bob')
    expect(upd({ passwordReset: true })).toBe('reset the password of bob')
    expect(upd({ displayName: 'Bobby' })).toBe('renamed the account bob to “Bobby”')
    expect(upd({ displayName: 'Bobby', isAdmin: true })).toBe('changed the account bob: display name set to “Bobby”, made an administrator')
    expect(upd({})).toBe('saved the account bob without changes')
    expect(say('admin-user-update', { userId: BOB.id, via: 'cli', password: true, sessionsDeleted: 1 }, { actor: null }))
      .toBe('reset the password of bob from the command line')
    expect(say('admin-user-update', { userId: 'u-gone', disabled: true })).toBe('disabled the account a deleted account')
  })

  it('settings-update', () => {
    expect(say('settings-update', { before: { registration: 'invite-only' }, after: { registration: 'open' } }))
      .toBe('changed registration from “Invite only” to “Open”')
    expect(say('settings-update', { before: { registration: 'closed' }, after: { registration: 'closed' } }))
      .toBe('saved the registration setting (“Closed”)')
  })

  it('storage.view', () => {
    expect(say('storage.view', null)).toBe('viewed the storage report')
  })

  it('gc.run', () => {
    const report = { at: 1, durationMs: 5, blobsRemoved: 3, bytesFreed: 100, orphanDocsRemoved: 0, versionsThinned: 1, projectsPurged: 0 }
    expect(say('gc.run', { ...report, trigger: 'admin' }))
      .toBe('ran the garbage collection: 3 unreferenced blobs removed, 1 old automatic version thinned')
    expect(say('gc.run', { ...report, blobsRemoved: 0, versionsThinned: 0, trigger: 'schedule' }, { actor: null }))
      .toBe('ran the scheduled garbage collection (nothing to remove)')
  })

  it('doc.rebuild', () => {
    expect(say('doc.rebuild', { fileId: 'f', fromEpoch: 1, toEpoch: 2, reason: 'admin' })).toBe('rebuilt a document of Demo paper')
    expect(say('doc.rebuild', { fileId: 'f', fromEpoch: 1, toEpoch: 2, reason: 'oversized' }, { actor: null }))
      .toBe('rebuilt an oversized document in Demo paper')
  })

  it('project.purge', () => {
    const purged = { id: 'p-9', name: '', deleted: true }
    expect(say('project.purge', { name: 'Old thesis', deletedAt: 5 }, { actor: null, project: purged }))
      .toBe('permanently removed the deleted project Old thesis')
    expect(say('project.purge', null, { actor: null, project: purged })).toBe('permanently removed the deleted project a deleted project')
  })
})

describe('audit sentences: members and invites', () => {
  it('member-add', () => {
    expect(say('member-add', { userId: BOB.id, role: 'editor', inviteId: 'i' })).toBe('added Bob Builder to Demo paper as an editor')
    expect(say('member-add', { userId: BOB.id, role: 'viewer', inviteId: 'i' }, { actor: BOB })).toBe('joined Demo paper as a viewer')
  })

  it('member-role-change', () => {
    expect(say('member-role-change', { userId: BOB.id, from: 'viewer', to: 'editor' }))
      .toBe('changed the role of Bob Builder in Demo paper from viewer to editor')
    expect(say('member-role-change', { userId: BOB.id, from: 'viewer', to: 'editor', inviteId: 'i' }, { actor: BOB }))
      .toBe('became an editor of Demo paper with an invite link (was a viewer)')
  })

  it('member-remove', () => {
    expect(say('member-remove', { userId: BOB.id, role: 'editor', left: false })).toBe('removed Bob Builder from Demo paper')
    expect(say('member-remove', { userId: BOB.id, role: 'editor', left: true }, { actor: BOB })).toBe('left Demo paper')
    expect(say('member-remove', { userId: 'u-gone', role: 'viewer', left: false })).toBe('removed a deleted account from Demo paper')
  })

  it('ownership-transfer', () => {
    expect(say('ownership-transfer', { from: ALICE.id, to: BOB.id })).toBe('transferred ownership of Demo paper to Bob Builder')
    expect(say('ownership-transfer', { from: BOB.id, to: ALICE.id }, { actor: null }))
      .toBe('transferred ownership of Demo paper from Bob Builder to Alice Admin')
  })

  it('invite-create', () => {
    expect(say('invite-create', { inviteId: 'i', role: 'editor', expiresAt: 9, maxUses: null })).toBe('created an editor invite link for Demo paper')
    expect(say('invite-create', { inviteId: 'i', role: 'viewer', expiresAt: 9, maxUses: 1 }))
      .toBe('created a viewer invite link for Demo paper (single use)')
    expect(say('invite-create', { inviteId: 'i', role: 'viewer', expiresAt: 9, maxUses: 5 }))
      .toBe('created a viewer invite link for Demo paper (up to 5 uses)')
  })

  it('invite-revoke', () => {
    expect(say('invite-revoke', { inviteId: 'i' })).toBe('revoked an invite link of Demo paper')
  })

  it('invite-accept', () => {
    expect(say('invite-accept', { inviteId: 'i', role: 'editor' }, { actor: BOB })).toBe('accepted an editor invite link to Demo paper')
  })
})

describe('audit sentences: projects and files', () => {
  it('project-create', () => {
    expect(say('project-create', { name: 'Demo paper' })).toBe('created Demo paper')
    // The name as created, even if the project was renamed since.
    expect(say('project-create', { name: 'Draft' })).toBe('created Draft')
    expect(say('project-create', { name: 'Thesis', import: true, files: 12, skipped: 2 })).toBe('imported Thesis from a zip file (12 files, 2 skipped)')
    expect(say('project-create', { name: 'Thesis', import: true, files: 1, skipped: 0 })).toBe('imported Thesis from a zip file (1 file)')
  })

  it('project-delete', () => {
    expect(say('project-delete', { name: 'Demo paper' }, { project: { ...PROJECT, deleted: true } })).toBe('deleted Demo paper')
  })

  it('project.setting', () => {
    expect(say('project.setting', { key: 'engine', from: 'pdflatex', to: 'xelatex' }))
      .toBe('changed the compiler of Demo paper from pdfLaTeX to XeLaTeX')
    expect(say('project.setting', { key: 'engine', from: 'xelatex', to: 'lualatex' }))
      .toBe('changed the compiler of Demo paper from XeLaTeX to LuaLaTeX')
    expect(say('project.setting', { key: 'name', from: 'Draft', to: 'Demo paper' })).toBe('renamed Draft to Demo paper')
    expect(say('project.setting', { key: 'mainFile', from: 'main.tex', to: 'paper/paper.tex' }))
      .toBe('changed the main file of Demo paper from main.tex to paper/paper.tex')
    expect(say('project.setting', { key: 'mainFile', from: null, to: 'main.tex' })).toBe('set the main file of Demo paper to main.tex')
    expect(say('project.setting', { key: 'colour', from: 'a', to: 'b' })).toBe('changed a setting of Demo paper')
  })

  it('file-delete', () => {
    expect(say('file-delete', { fileId: 'f', name: 'fig.png', count: 1 })).toBe('deleted fig.png in Demo paper')
    expect(say('file-delete', { fileId: 'f', name: 'chapters', count: 4 })).toBe('deleted chapters in Demo paper (4 files and folders)')
  })

  it('file.restore', () => {
    expect(say('file.restore', { fileId: 'f', name: 'fig.png', parentId: 'r', count: 1 })).toBe('restored fig.png in Demo paper from the trash')
  })

  it('file.purge', () => {
    expect(say('file.purge', { fileId: 'f', name: 'old.tex', count: 1 })).toBe('permanently deleted old.tex from the trash of Demo paper')
    expect(say('file.purge', { batch: 'b', count: 3, reason: 'expired' }, { actor: null }))
      .toBe('permanently deleted 3 expired trash items of Demo paper')
  })

  it('trash.empty', () => {
    expect(say('trash.empty', { batches: 2, count: 5 })).toBe('emptied the trash of Demo paper (5 items)')
  })
})

describe('audit sentences: history', () => {
  it('version.create', () => {
    expect(say('version.create', { versionId: 'v', label: 'Draft 1' })).toBe('saved the version “Draft 1” of Demo paper')
    expect(say('version.create', { versionId: 'v', label: null })).toBe('saved a version of Demo paper')
  })

  it('version.label', () => {
    expect(say('version.label', { versionId: 'v', label: 'Submitted' })).toBe('named a version of Demo paper “Submitted”')
    expect(say('version.label', { versionId: 'v', label: null })).toBe('removed the name of a version of Demo paper')
  })

  it('version.restore', () => {
    const base = { versionId: 'v', preRestoreVersionId: 'w', restored: 3, trashed: 0 }
    expect(say('version.restore', { ...base, label: 'Draft 1', versionAt: 5 })).toBe('restored Demo paper to “Draft 1”')
    expect(say('version.restore', { ...base, label: null, versionAt: 5 })).toBe(`restored Demo paper to the version of ${formatWhen(5)}`)
    expect(say('version.restore', base)).toBe('restored Demo paper to an earlier version') // entries from before M4
    expect(say('version.restore', { ...base, label: 'Draft 1', paths: ['a.tex', 'b.tex'] })).toBe('restored 2 files of Demo paper from “Draft 1”')
  })
})

describe('audit page helpers', () => {
  it('has a sentence for every known action; unknown ones fall back to the action name', () => {
    for (const action of Object.values(AUDIT_CATEGORIES).flat()) {
      expect(auditSentence(entry(action, {})), action).not.toBe(action)
    }
    expect(say('some-future-action', { x: 1 })).toBe('some-future-action')
    expect(say('toString', null)).toBe('toString') // not a prototype method
  })

  it('marks names and files for emphasis', () => {
    expect(auditParts(entry('project.setting', { key: 'mainFile', from: null, to: 'main.tex' })))
      .toEqual(['set the main file of ', { name: 'Demo paper' }, ' to ', { file: 'main.tex' }])
    expect(auditParts(entry('login', {}))).toEqual(['logged in'])
  })

  it('names the actor; a purged project without a recorded name', () => {
    expect(actorLabel(entry('login', null))).toBe('Alice Admin')
    expect(actorLabel(entry('gc.run', null, { actor: null }))).toBe('Server')
    expect(actorLabel(entry('login', null, { actor: { id: 'u-x', username: '', displayName: '' } }))).toBe('A deleted account')
    expect(say('invite-revoke', null, { project: { id: 'p-9', name: '', deleted: true } })).toBe('revoked an invite link of a deleted project')
  })

  it('marks failed logins and deletions in red', () => {
    for (const a of ['login-failure', 'project-delete', 'project.purge', 'file-delete', 'file.purge', 'trash.empty']) {
      expect(isAlarming(entry(a, null)), a).toBe(true)
    }
    expect(isAlarming(entry('member-remove', { userId: BOB.id, left: false }))).toBe(true)
    expect(isAlarming(entry('member-remove', { userId: BOB.id, left: true }, { actor: BOB }))).toBe(false)
    for (const a of ['login', 'project-create', 'file.restore', 'version.restore', 'some-future-action']) {
      expect(isAlarming(entry(a, null)), a).toBe(false)
    }
  })

  it('lists the recorded details, naming known people', () => {
    expect(detailLines(entry('member-add', { userId: BOB.id, role: 'editor', inviteId: null, n: 3, o: { a: 1 } }))).toEqual([
      { key: 'userId', value: 'u-bob (bob)' },
      { key: 'role', value: 'editor' },
      { key: 'inviteId', value: 'null' },
      { key: 'n', value: '3' },
      { key: 'o', value: '{"a":1}' },
    ])
    expect(detailLines(entry('login', null))).toEqual([])
  })

  it('announces what "Load older" added', () => {
    expect(olderLoadedText(100, true)).toBe('Loaded 100 older entries.')
    expect(olderLoadedText(1, false)).toBe('Loaded 1 older entry. These are the oldest.')
    expect(olderLoadedText(0, false)).toBe('No older entries.')
  })

  it('filter options and periods', () => {
    expect(CATEGORY_OPTIONS.map(o => o.label)).toEqual(['All activity', 'Accounts and sign-in', 'Administration', 'Members and invites',
      'Projects and files', 'History'])
    expect(CATEGORY_OPTIONS.slice(1).map(o => o.value).sort()).toEqual(Object.keys(AUDIT_CATEGORIES).sort())
    expect(PERIOD_OPTIONS.map(o => o.value)).toEqual(['24h', '7d', '30d', 'all'])
    const now = 100 * 24 * 3600_000
    expect(periodSince('24h', now)).toBe(now - 24 * 3600_000)
    expect(periodSince('7d', now)).toBe(now - 7 * 24 * 3600_000)
    expect(periodSince('30d', now)).toBe(now - 30 * 24 * 3600_000)
    expect(periodSince('all', now)).toBeUndefined()
  })
})
