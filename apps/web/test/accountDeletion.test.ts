import { describe, expect, it } from 'vitest'
import type { AccountDeletionPreview } from '@ligature/shared'
import {
  adminDeletedText, adminDeletionBlocked, adminDeletionText, CANNOT_UNDO, selfDeletionView,
} from '../src/lib/accountDeletion.ts'
import { FORMER_MEMBER, personName } from '../src/lib/people.ts'
import { authorsText } from '../src/lib/history.ts'
import { adminUserActions } from '../src/lib/adminActions.ts'
import { errorMessage } from '../src/lib/errors.ts'

function preview(over: Partial<AccountDeletionPreview> = {}): AccountDeletionPreview {
  return { deletedProjects: [], sharedOwned: [], leftProjects: 0, blocked: null, ...over }
}

const THESIS = { id: 'p-1', name: 'Thesis' }
const NOTES = { id: 'p-2', name: 'Notes' }
const shared = (id: string, name: string, owner: string) => ({ id, name, newOwner: { userId: `u-${owner}`, displayName: owner } })

describe('self-deletion dialog', () => {
  it('is blocked by projects shared with others, listing them (for links)', () => {
    const v = selfDeletionView(preview({ blocked: 'owns-shared-projects', sharedOwned: [shared('p-3', 'Paper', 'Bob')] }))
    expect(v).toMatchObject({ state: 'blocked', reason: 'owns-shared-projects', projects: [{ id: 'p-3', name: 'Paper' }] })
    expect(v.state === 'blocked' && v.text).toContain('You own a project that other people are members of')
    expect(v.state === 'blocked' && v.text).toContain('Members')
    const two = selfDeletionView(preview({ blocked: 'owns-shared-projects', sharedOwned: [shared('a', 'A', 'B'), shared('b', 'B', 'C')] }))
    expect(two.state === 'blocked' && two.text).toContain('You own 2 projects')
    // The new owner is an admin-deletion detail: not passed on to the links.
    expect(two.state === 'blocked' && two.projects).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  })

  it('is blocked when you are the last administrator', () => {
    const v = selfDeletionView(preview({ blocked: 'last-admin', deletedProjects: [THESIS] }))
    expect(v).toMatchObject({ state: 'blocked', reason: 'last-admin', projects: [] })
    expect(v.state === 'blocked' && v.text).toContain('only active administrator')
  })

  it('lists the projects deleted with the account, and what stays', () => {
    const v = selfDeletionView(preview({ deletedProjects: [THESIS, NOTES], leftProjects: 3 }))
    expect(v.state).toBe('ready')
    if (v.state !== 'ready') return
    expect(v.deletedText).toBe('These 2 projects have no other members and are deleted with your account:')
    expect(v.deleted).toEqual([THESIS, NOTES])
    expect(v.notes).toEqual([
      'You leave 3 projects shared with you.',
      'What you wrote in other people’s projects stays there, shown as “a former member”.',
      'Your username becomes free for a new account.',
    ])
  })

  it('says so when nothing is deleted or left', () => {
    const one = selfDeletionView(preview({ deletedProjects: [THESIS], leftProjects: 1 }))
    expect(one.state === 'ready' && one.deletedText).toBe('This project has no other members and is deleted with your account:')
    expect(one.state === 'ready' && one.notes[0]).toBe('You leave 1 project shared with you.')
    const none = selfDeletionView(preview())
    expect(none.state === 'ready' && none.deletedText).toBe('You own no projects, so none is deleted.')
    expect(none.state === 'ready' && none.notes[0]).toBe('You are not a member of anyone else’s project.')
  })
})

describe('admin deletion dialog', () => {
  const BOB = { username: 'bob', displayName: 'Bob Builder' }

  it('is only blocked by the last-admin rule (shared projects are handed over)', () => {
    expect(adminDeletionBlocked(preview({ blocked: 'last-admin' }))).toContain('only active administrator')
    expect(adminDeletionBlocked(preview({ blocked: 'owns-shared-projects', sharedOwned: [shared('p', 'P', 'Carol')] }))).toBeNull()
    expect(adminDeletionBlocked(preview())).toBeNull()
  })

  it('describes deleted projects, ownership transfers and projects left', () => {
    const text = adminDeletionText(preview({
      deletedProjects: [THESIS], sharedOwned: [shared('p-3', 'Paper', 'Carol'), shared('p-4', 'Slides', '')], leftProjects: 2,
    }), BOB)
    expect(text.split('\n')).toEqual([
      'Delete the account bob (Bob Builder)? They are logged out everywhere immediately.',
      '',
      'Deleted with it (no other members): 1 project',
      '• Thesis',
      'Ownership passes to the longest-standing editor (or viewer, if there is no editor):',
      '• Paper → Carol',
      `• Slides → ${FORMER_MEMBER}`,
      'They leave 2 projects shared with them.',
      '',
      `Their edits in other people’s projects stay, shown as “a former member”. The username becomes free for a new account. ${CANNOT_UNDO}`,
    ])
  })

  it('says when no project is deleted, and cuts long lists', () => {
    expect(adminDeletionText(preview(), BOB)).toContain('No project is deleted with it.')
    expect(adminDeletionText(preview(), BOB)).not.toContain('Ownership passes')
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))
    const lines = adminDeletionText(preview({ deletedProjects: many }), BOB).split('\n')
    expect(lines).toContain('Deleted with it (no other members): 12 projects')
    expect(lines.filter(l => l.startsWith('• '))).toHaveLength(8)
    expect(lines).toContain('• … and 5 more')
    expect(lines).toContain('• P6')
    expect(lines).not.toContain('• P7')
  })

  it('toasts what was done', () => {
    expect(adminDeletedText('bob', { projectsDeleted: 2, ownershipTransferred: 1, projectsLeft: 4 }))
      .toBe('Deleted the account bob. 2 projects deleted, 1 project handed over.')
    expect(adminDeletedText('bob', { projectsDeleted: 0, ownershipTransferred: 0, projectsLeft: 4 })).toBe('Deleted the account bob.')
    expect(adminDeletedText('bob', null)).toBe('Deleted the account bob.')
  })

  it('offers Delete for everyone but yourself', () => {
    expect(adminUserActions('me', 'me')).not.toContain('delete')
    expect(adminUserActions('other', 'me')).toContain('delete')
  })
})

describe('errors of account deletion', () => {
  it('has a message for each refusal', () => {
    expect(errorMessage({ code: 'wrong-password' })).toBe('The password is wrong.')
    expect(errorMessage({ code: 'owns-shared-projects' })).toContain('Transfer their ownership in Members first')
    expect(errorMessage({ code: 'last-admin' })).toBe('This would leave the server without an active administrator.')
    expect(errorMessage({ code: 'confirm-mismatch' })).toBe('The username typed does not match the account.')
  })
})

describe('"a former member"', () => {
  it('stands in for the name of a deleted account', () => {
    expect(personName('Alice')).toBe('Alice')
    expect(personName('')).toBe(FORMER_MEMBER)
    expect(personName('  ')).toBe(FORMER_MEMBER)
    expect(personName(null)).toBe(FORMER_MEMBER)
    expect(personName(undefined)).toBe(FORMER_MEMBER)
  })

  it('in version authors and "created by"', () => {
    expect(authorsText({ authors: ['Alice', ''], createdBy: '' })).toBe(`Alice, ${FORMER_MEMBER}`)
    expect(authorsText({ authors: ['', ''], createdBy: '' })).toBe(FORMER_MEMBER) // once
    expect(authorsText({ authors: ['Alice', FORMER_MEMBER, ''], createdBy: '' })).toBe(`Alice, ${FORMER_MEMBER}`)
    // Two living people may share a display name: both stay, and count towards "+N".
    expect(authorsText({ authors: ['Alex', 'Alex'], createdBy: '' })).toBe('Alex, Alex')
    expect(authorsText({ authors: ['Alex', 'Alex', 'Bea', 'Cy', '', ''], createdBy: '' })).toBe('Alex, Alex, Bea +2')
    // A named version, a restore or an import always had a creator: no name means a deleted account.
    expect(authorsText({ kind: 'named', authors: ['Alice'], createdBy: '' })).toBe(`Alice · by ${FORMER_MEMBER}`)
    expect(authorsText({ kind: 'pre_restore', authors: [], createdBy: '' })).toBe(`by ${FORMER_MEMBER}`)
    expect(authorsText({ kind: 'import', authors: [], createdBy: 'Bob' })).toBe('by Bob')
    // Automatic versions have no creator.
    expect(authorsText({ kind: 'auto', authors: ['Alice'], createdBy: '' })).toBe('Alice')
    expect(authorsText({ kind: 'compile', authors: [], createdBy: '' })).toBe('')
  })
})
