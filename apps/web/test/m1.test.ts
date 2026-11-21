import { describe, expect, it } from 'vitest'
import type { TreeEntry } from '@ligature/shared'
import { errorCode, errorMessage } from '../src/lib/errors.ts'
import { adminPath, ADMIN_TABS, inviteUrl, loginPath, parseHash, routePath, safeNext, signupPath } from '../src/lib/routes.ts'
import {
  childNamed, entryPath, folderLabel, formatBytes, isInlineImage, isSameOrInside, mainFileCandidates, moveTargets,
  nameProblem, openFileOutcome, planUploads, targetFolder,
} from '../src/lib/treeOps.ts'
import {
  authFailedActions, closeActions, isCloseReason, metaEventActions, parseMetaEvent, resyncActions, SESSION_ENDED,
  type EventContext,
} from '../src/lib/projectEvents.ts'
import { adminUserActions } from '../src/lib/adminActions.ts'
import { displayNameProblem, passwordProblem, signupMode, usernameProblem } from '../src/lib/validation.ts'

class FakeApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code)
  }
}

describe('errorMessage', () => {
  it('maps known codes to friendly text', () => {
    expect(errorMessage(new FakeApiError(401, 'invalid-credentials', 'Wrong username or password'))).toBe('Wrong username or password.')
    expect(errorMessage(new FakeApiError(429, 'rate-limited'))).toMatch(/Too many attempts/)
    expect(errorMessage(new FakeApiError(403, 'registration-closed'))).toMatch(/Registration is closed/)
    expect(errorMessage(new FakeApiError(403, 'invite-required'))).toMatch(/invite link/)
    expect(errorMessage(new FakeApiError(409, 'username-taken'))).toBe('That username is already taken.')
    expect(errorMessage(new FakeApiError(400, 'weak-password'))).toMatch(/10 to 256/)
    expect(errorMessage(new FakeApiError(409, 'last-admin', 'x'))).toMatch(/administrator/)
    expect(errorMessage(new FakeApiError(409, 'name-taken'))).toMatch(/already exists/)
    expect(errorMessage(new FakeApiError(409, 'cycle'))).toMatch(/into itself/)
  })

  it('prefers the server message for bad-request and size errors', () => {
    expect(errorMessage(new FakeApiError(400, 'bad-request', 'username: invalid username'))).toBe('Username: invalid username.')
    expect(errorMessage(new FakeApiError(400, 'bad-request'))).toBe('The request was rejected as invalid.')
    expect(errorMessage(new FakeApiError(413, 'too-large', 'Uploads are limited to 50 MB'))).toBe('Uploads are limited to 50 MB.')
    expect(errorMessage(new FakeApiError(413, 'too-large'))).toBe('The file is too large.')
  })

  it('shows the server message for rate limits (upload byte budget is not a login attempt)', () => {
    expect(errorMessage(new FakeApiError(429, 'rate-limited', 'Upload volume limit reached; try again later')))
      .toBe('Upload volume limit reached; try again later.')
    expect(errorMessage(new FakeApiError(429, 'rate-limited', 'Too many attempts; try again later')))
      .toBe('Too many attempts; try again later.')
    expect(errorMessage(new FakeApiError(429, 'rate-limited'))).toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('handles network failures, unknown codes and overrides', () => {
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('network')
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/Cannot reach the server/)
    expect(errorMessage(new FakeApiError(418, 'teapot', 'short and stout'))).toBe('Short and stout.')
    expect(errorMessage(new FakeApiError(500, 'http-500'))).toBe('Something went wrong (http-500).')
    expect(errorMessage('weird')).toBe('Something went wrong (unknown).')
    expect(errorMessage(new FakeApiError(403, 'invalid-credentials'), { 'invalid-credentials': 'The current password is wrong.' }))
      .toBe('The current password is wrong.')
  })
})

describe('routes', () => {
  it('parses every route', () => {
    expect(parseHash('')).toEqual({ name: 'projects' })
    expect(parseHash('#/')).toEqual({ name: 'projects' })
    expect(parseHash('#/login')).toEqual({ name: 'login', next: null })
    expect(parseHash('#/login?next=%2Finvite%2Fabc')).toEqual({ name: 'login', next: '/invite/abc' })
    expect(parseHash('#/signup?invite=tok_-1')).toEqual({ name: 'signup', invite: 'tok_-1', setup: null })
    expect(parseHash('#/signup')).toEqual({ name: 'signup', invite: null, setup: null })
    expect(parseHash('#/signup?setup=Ab-_9xYz')).toEqual({ name: 'signup', invite: null, setup: 'Ab-_9xYz' })
    expect(parseHash('#/signup?setup=')).toEqual({ name: 'signup', invite: null, setup: null })
    expect(parseHash('#/signup?invite=i&setup=s')).toEqual({ name: 'signup', invite: 'i', setup: 's' })
    expect(parseHash('#/invite/abc-DEF_1')).toEqual({ name: 'invite', token: 'abc-DEF_1' })
    expect(parseHash('#/project/1234')).toEqual({ name: 'project', id: '1234' })
    expect(parseHash('#/account')).toEqual({ name: 'account' })
    expect(parseHash('#/admin')).toEqual({ name: 'admin', tab: 'users' })
    expect(parseHash('#/admin/storage')).toEqual({ name: 'admin', tab: 'storage' })
    expect(parseHash('#/admin/audit')).toEqual({ name: 'admin', tab: 'audit' })
    expect(parseHash('#/admin/users')).toEqual({ name: 'not-found' }) // the users tab is plain #/admin
    expect(parseHash('#/admin/nope')).toEqual({ name: 'not-found' })
    expect(parseHash('#/nope')).toEqual({ name: 'not-found' })
    expect(parseHash('#/project/%E0%A4%A')).toEqual({ name: 'not-found' }) // malformed escape
  })

  it('only accepts safe in-app next paths', () => {
    expect(safeNext('/project/abc')).toBe('/project/abc')
    expect(safeNext('/invite/xyz')).toBe('/invite/xyz')
    expect(safeNext('https://evil.example')).toBeNull()
    expect(safeNext('//evil.example')).toBeNull()
    expect(safeNext('/\\evil')).toBeNull()
    expect(safeNext('/login')).toBeNull()
    expect(safeNext('/signup')).toBeNull()
    expect(safeNext('/signup?setup=tok')).toBeNull() // never carried along in ?next=
    expect(routePath(parseHash('#/signup?setup=tok'))).toBe('/signup')
    expect(safeNext('/unknown')).toBeNull()
    expect(safeNext(null)).toBeNull()
    expect(parseHash('#/login?next=https%3A%2F%2Fevil.example')).toEqual({ name: 'login', next: null })
  })

  it('builds paths and links that round-trip', () => {
    expect(loginPath('/project/a b')).toBe('/login?next=%2Fproject%2Fa%20b')
    expect(parseHash(`#${loginPath('/invite/t')}`)).toEqual({ name: 'login', next: '/invite/t' })
    expect(loginPath('/projects')).toBe('/login')
    expect(loginPath(null)).toBe('/login')
    expect(signupPath('t')).toBe('/signup?invite=t')
    expect(signupPath(null)).toBe('/signup')
    expect(routePath({ name: 'project', id: 'x/y' })).toBe('/project/x%2Fy')
    expect(parseHash(`#${routePath({ name: 'project', id: 'x/y' })}`)).toEqual({ name: 'project', id: 'x/y' })
    expect(inviteUrl('http://localhost:5173', 'abc')).toBe('http://localhost:5173/#/invite/abc')
    expect(ADMIN_TABS.map(adminPath)).toEqual(['/admin', '/admin/storage', '/admin/audit'])
    for (const tab of ADMIN_TABS) {
      expect(parseHash(`#${routePath({ name: 'admin', tab })}`)).toEqual({ name: 'admin', tab })
      expect(safeNext(adminPath(tab))).toBe(adminPath(tab)) // back to the same tab after logging in
    }
  })
})

// root
//  ├─ main.tex
//  ├─ refs.bib
//  ├─ fig/            ├─ plot.png
//  └─ chapters/       ├─ intro.tex
//                     └─ deep/  └─ x.tex
const T: TreeEntry[] = [
  { id: 'root', parentId: null, name: '', kind: 'folder' },
  { id: 'main', parentId: 'root', name: 'main.tex', kind: 'text', epoch: 0 },
  { id: 'bib', parentId: 'root', name: 'refs.bib', kind: 'text', epoch: 0 },
  { id: 'fig', parentId: 'root', name: 'fig', kind: 'folder' },
  { id: 'png', parentId: 'fig', name: 'plot.png', kind: 'binary', size: 10 },
  { id: 'ch', parentId: 'root', name: 'chapters', kind: 'folder' },
  { id: 'intro', parentId: 'ch', name: 'intro.tex', kind: 'text', epoch: 2 },
  { id: 'deep', parentId: 'ch', name: 'deep', kind: 'folder' },
  { id: 'x', parentId: 'deep', name: 'x.tex', kind: 'text', epoch: 0 },
]

describe('tree operations', () => {
  it('computes paths', () => {
    expect(entryPath(T, 'root')).toBe('')
    expect(entryPath(T, 'x')).toBe('chapters/deep/x.tex')
    expect(entryPath(T, 'missing')).toBeNull()
    expect(folderLabel('')).toBe('/')
    expect(folderLabel('a/b')).toBe('a/b/')
    // a broken parent chain is not a path
    expect(entryPath([...T, { id: 'orphan', parentId: 'gone', name: 'o', kind: 'text' }], 'orphan')).toBeNull()
  })

  it('finds siblings case-insensitively and checks ancestry', () => {
    expect(childNamed(T, 'root', 'MAIN.TEX')?.id).toBe('main')
    expect(childNamed(T, 'root', 'main.tex', 'main')).toBeUndefined()
    expect(isSameOrInside(T, 'x', 'ch')).toBe(true)
    expect(isSameOrInside(T, 'ch', 'ch')).toBe(true)
    expect(isSameOrInside(T, 'ch', 'x')).toBe(false)
  })

  it('validates new names', () => {
    expect(nameProblem(T, 'root', 'new.tex')).toBeNull()
    expect(nameProblem(T, 'root', '')).toMatch(/Enter a name/)
    expect(nameProblem(T, 'root', ' a.tex')).toMatch(/spaces/)
    expect(nameProblem(T, 'root', 'a/b.tex')).toMatch(/cannot contain/)
    expect(nameProblem(T, 'root', '..')).toMatch(/cannot contain/)
    expect(nameProblem(T, 'root', 'Main.TEX')).toMatch(/already exists/)
    expect(nameProblem(T, 'root', 'main.tex', 'main')).toBeNull() // renaming itself (e.g. case change)
    expect(nameProblem(T, 'gone', 'a.tex')).toMatch(/no longer exists/)
    expect(nameProblem(T, 'root', 'x'.repeat(256))).toMatch(/cannot contain|too long/)
  })

  it('rejects paths beyond the depth limit, counting a moved folder’s subtree', () => {
    const chain: TreeEntry[] = [{ id: 'root', parentId: null, name: '', kind: 'folder' }]
    for (let i = 1; i <= 32; i++) chain.push({ id: `d${i}`, parentId: i === 1 ? 'root' : `d${i - 1}`, name: `d${i}`, kind: 'folder' })
    expect(nameProblem(chain, 'd32', 'f.tex')).toBe('The path would be too long or too deeply nested.') // 33 segments
    expect(nameProblem(chain, 'd31', 'f.tex')).toBeNull() // exactly 32
    // Renaming 'ch' is fine, but the subtree (deep/x.tex) counts toward the length limit.
    expect(nameProblem(T, 'root', 'c'.repeat(255), 'ch')).toBeNull()
    const longNames: TreeEntry[] = [...T, { id: 'long', parentId: 'deep', name: 'y'.repeat(255), kind: 'folder' },
      { id: 'long2', parentId: 'long', name: 'z'.repeat(255), kind: 'folder' },
      { id: 'long3', parentId: 'long2', name: 'w'.repeat(255), kind: 'text' }]
    expect(nameProblem(longNames, 'root', 'c'.repeat(255), 'ch')).toMatch(/too long/)
  })

  it('offers move targets without cycles or no-ops', () => {
    const opts = moveTargets(T, 'ch')
    const byId = Object.fromEntries(opts.map(o => [o.id, o]))
    expect(opts.map(o => o.label)).toEqual(['/', 'chapters/', 'chapters/deep/', 'fig/'])
    expect(byId['root']!.disabled).toBe(true) // current folder
    expect(byId['ch']!.disabled).toBe(true) // itself
    expect(byId['deep']!.disabled).toBe(true) // descendant
    expect(byId['fig']!.disabled).toBe(false)
    // A file: its folder is disabled, folders with a same-named child are disabled.
    const withDup = [...T, { id: 'dup', parentId: 'fig', name: 'main.tex', kind: 'text' as const, epoch: 0 }]
    const fileOpts = Object.fromEntries(moveTargets(withDup, 'main').map(o => [o.id, o]))
    expect(fileOpts['root']!.reason).toBe('current folder')
    expect(fileOpts['fig']!.reason).toBe('name already used there')
    expect(fileOpts['ch']!.disabled).toBe(false)
    expect(moveTargets(T, 'missing')).toEqual([])
  })

  it('resolves the folder for new files and drops', () => {
    expect(targetFolder(T, 'root', null)).toBe('root') // empty area
    expect(targetFolder(T, 'root', 'fig')).toBe('fig') // onto a folder
    expect(targetFolder(T, 'root', 'png')).toBe('fig') // onto a file: its folder
    expect(targetFolder(T, 'root', 'main')).toBe('root')
    expect(targetFolder(T, 'root', 'x')).toBe('deep')
    expect(targetFolder(T, 'root', 'deleted-id')).toBe('root')
  })

  it('knows which images may be shown inline (never SVG)', () => {
    expect(isInlineImage('a.png')).toBe(true)
    expect(isInlineImage('a.JPG')).toBe(true)
    expect(isInlineImage('a.jpeg')).toBe(true)
    expect(isInlineImage('a.gif')).toBe(true)
    expect(isInlineImage('a.webp')).toBe(true)
    expect(isInlineImage('a.svg')).toBe(false)
    expect(isInlineImage('a.pdf')).toBe(false)
    expect(isInlineImage('png')).toBe(false)
  })

  it('lists .tex text files as main file candidates', () => {
    expect(mainFileCandidates(T)).toEqual([
      { id: 'intro', path: 'chapters/intro.tex' }, { id: 'x', path: 'chapters/deep/x.tex' }, { id: 'main', path: 'main.tex' },
    ].sort((a, b) => a.path.localeCompare(b.path)))
  })

  it('plans uploads: create, replace, skip', () => {
    const files = [
      { name: 'new.png', size: 5 },
      { name: 'main.tex', size: 5 },
      { name: 'MAIN.tex', size: 5 },
      { name: 'Refs.bib', size: 5 },
      { name: 'fig', size: 5 },
      { name: 'big.pdf', size: 100 },
      { name: 'bad:name', size: 1 },
    ]
    const plan = planUploads(T, 'root', files, 50)
    expect(plan.map(p => p.action)).toEqual(['create', 'replace', 'skip', 'skip', 'skip', 'skip', 'skip'])
    expect(plan[1]).toMatchObject({ action: 'replace', existing: { id: 'main' } })
    expect(plan[2]).toMatchObject({ reason: 'selected twice' })
    expect(plan[3]).toMatchObject({ reason: '"refs.bib" exists (names are not case-sensitive)' })
    expect(plan[4]).toMatchObject({ reason: 'a folder with that name exists' })
    expect(plan[5]).toMatchObject({ reason: 'larger than 0 MB' })
    expect(plan[6]).toMatchObject({ reason: 'invalid file name' })
    expect(planUploads(T, 'fig', [{ name: 'plot.png', size: 1 }], 50)[0]).toMatchObject({ action: 'replace' })
    expect(planUploads(T, 'gone', [{ name: 'a.png', size: 1 }], 50)[0]).toMatchObject({ action: 'skip' })
  })

  it('tells what happened to the open file after a refetch', () => {
    expect(openFileOutcome(T, 'intro', 2)).toBe('keep')
    expect(openFileOutcome(T, 'intro', 1)).toBe('reopen')
    expect(openFileOutcome(T, 'gone', 0)).toBe('deleted')
    expect(openFileOutcome(T, 'png', 0)).toBe('deleted')
  })

  it('formats sizes', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1048576)).toBe('3.0 MB')
  })
})

describe('project events', () => {
  const ctx: EventContext = { meId: 'me', treeVersion: 5, membersOpen: false }

  it('parses and validates meta event payloads', () => {
    expect(parseMetaEvent('{"type":"tree-changed","treeVersion":3}')).toEqual({ type: 'tree-changed', treeVersion: 3 })
    expect(parseMetaEvent('{"type":"project-changed"}')).toEqual({ type: 'project-changed' })
    expect(parseMetaEvent('{"type":"members-changed","extra":1}')).toEqual({ type: 'members-changed' })
    expect(parseMetaEvent('{"type":"project-deleted"}')).toEqual({ type: 'project-deleted' })
    expect(parseMetaEvent('{"type":"access-revoked","userId":"u"}')).toEqual({ type: 'access-revoked', userId: 'u' })
    expect(parseMetaEvent('{"type":"compile-finished","buildId":"b","status":"success"}'))
      .toEqual({ type: 'compile-finished', buildId: 'b', status: 'success' })
    expect(parseMetaEvent('{"type":"compile-finished","buildId":"b","status":"bogus"}')).toBeNull()
    expect(parseMetaEvent('{"type":"tree-changed"}')).toBeNull()
    expect(parseMetaEvent('{"type":"access-revoked"}')).toBeNull()
    expect(parseMetaEvent('{"type":"other"}')).toBeNull()
    expect(parseMetaEvent('[1]')).toBeNull()
    expect(parseMetaEvent('null')).toBeNull()
    expect(parseMetaEvent('not json')).toBeNull()
  })

  it('refetches on tree and project changes', () => {
    expect(metaEventActions({ type: 'tree-changed', treeVersion: 6 }, ctx)).toEqual([{ type: 'refresh-project' }])
    expect(metaEventActions({ type: 'tree-changed', treeVersion: 5 }, ctx)).toEqual([]) // already have it
    expect(metaEventActions({ type: 'project-changed' }, ctx)).toEqual([{ type: 'refresh-project' }])
  })

  it('refetches members only when the panel is open', () => {
    expect(metaEventActions({ type: 'members-changed' }, ctx)).toEqual([])
    expect(metaEventActions({ type: 'members-changed' }, { ...ctx, membersOpen: true })).toEqual([{ type: 'refresh-members' }])
    expect(metaEventActions({ type: 'access-revoked', userId: 'other' }, { ...ctx, membersOpen: true }))
      .toEqual([{ type: 'drop-peer', userId: 'other' }, { type: 'refresh-members' }])
    expect(metaEventActions({ type: 'access-revoked', userId: 'other' }, ctx)).toEqual([{ type: 'drop-peer', userId: 'other' }])
  })

  it('rechecks access when my access is revoked, leaves when the project is deleted', () => {
    expect(metaEventActions({ type: 'access-revoked', userId: 'me' }, ctx)).toEqual([
      { type: 'recheck-access', notice: 'Your access to this project changed.', leave: 'You were removed from this project.' },
    ])
    expect(metaEventActions({ type: 'project-deleted' }, ctx)).toEqual([{ type: 'leave', notice: 'This project was deleted.' }])
    expect(metaEventActions({ type: 'compile-finished', buildId: 'b', status: 'failure' }, ctx))
      .toEqual([{ type: 'compile-finished', buildId: 'b', status: 'failure' }])
  })

  it('maps server CLOSE reasons', () => {
    expect(isCloseReason('role-changed')).toBe(true)
    expect(isCloseReason('')).toBe(false)
    expect(isCloseReason(undefined)).toBe(false)
    expect(closeActions('role-changed', 'meta')).toEqual([{ type: 'reconnect', notice: 'Your role in this project changed.' }])
    expect(closeActions('access-revoked', 'meta')[0]!.type).toBe('recheck-access')
    expect(closeActions('project-deleted', 'meta')[0]!.type).toBe('leave')
    expect(closeActions('account-disabled', 'meta')[0]!.type).toBe('session-lost')
    expect(closeActions('session-ended', 'meta')[0]!.type).toBe('session-lost')
    // Project-wide reasons are handled once, from the meta doc.
    expect(closeActions('role-changed', 'file')).toEqual([{ type: 'file-reconnect' }])
    expect(closeActions('access-revoked', 'file')).toEqual([])
    expect(closeActions('file-deleted', 'file')[0]!.type).toBe('file-gone')
    expect(closeActions('file-deleted', 'meta')).toEqual([])
  })

  it('uses neutral wording: the deletion or logout may have come from this very user', () => {
    // Deleting the folder of your own open file must not blame "a collaborator".
    expect(closeActions('file-deleted', 'file')).toEqual([{ type: 'file-gone', notice: 'The open file was moved to the trash.' }])
    expect(closeActions('session-ended', 'meta')).toEqual([{ type: 'session-lost', notice: SESSION_ENDED }])
    expect(SESSION_ENDED).not.toMatch(/collaborator|another device/)
    for (const reason of ['file-deleted', 'session-ended'] as const) {
      for (const a of [...closeActions(reason, 'file'), ...closeActions(reason, 'meta')]) {
        if ('notice' in a) expect(a.notice).not.toMatch(/collaborator/)
      }
    }
  })

  it('refetches the project (and open member list) after the meta doc resyncs, e.g. after an outage', () => {
    expect(resyncActions({ membersOpen: false })).toEqual([{ type: 'refresh-project' }, { type: 'refresh-trash' }, { type: 'refresh-versions' }])
    expect(resyncActions({ membersOpen: true })).toEqual([{ type: 'refresh-project' }, { type: 'refresh-trash' }, { type: 'refresh-versions' }, { type: 'refresh-members' }])
  })

  it('maps authentication failures', () => {
    expect(authFailedActions('forbidden', 'meta')[0]!.type).toBe('recheck-access')
    expect(authFailedActions('forbidden', 'file')[0]!.type).toBe('recheck-access')
    expect(authFailedActions('not-found', 'file')[0]!.type).toBe('file-gone')
    expect(authFailedActions('file-deleted', 'file')[0]!.type).toBe('file-gone')
    expect(authFailedActions('not-found', 'meta')[0]!.type).toBe('leave')
    expect(authFailedActions('reload-required', 'file')).toEqual([{ type: 'file-reload' }])
    expect(authFailedActions('reload-required', 'meta')).toEqual([{ type: 'refresh-project' }])
    expect(authFailedActions('unauthenticated', 'file')[0]!.type).toBe('session-lost')
    expect(authFailedActions('weird', 'file')[0]!.type).toBe('file-gone')
    expect(authFailedActions('weird', 'meta')[0]!.type).toBe('recheck-access')
  })
})

describe('account validation', () => {
  it('checks usernames like the server', () => {
    expect(usernameProblem('alice')).toBeNull()
    expect(usernameProblem('Alice.B-1_c')).toBeNull() // lowercased before checking
    expect(usernameProblem('ab')).toMatch(/3 to 32/)
    expect(usernameProblem('a'.repeat(33))).toMatch(/3 to 32/)
    expect(usernameProblem('.alice')).toMatch(/lowercase/)
    expect(usernameProblem('al ice')).toMatch(/lowercase/)
  })

  it('checks display names and passwords', () => {
    expect(displayNameProblem('  Alice ')).toBeNull()
    expect(displayNameProblem('   ')).toMatch(/Enter/)
    expect(displayNameProblem('a\u0007b')).toMatch(/control/)
    expect(displayNameProblem('x'.repeat(65))).toMatch(/64/)
    expect(passwordProblem('short')).toMatch(/at least 10/)
    expect(passwordProblem('x'.repeat(257))).toMatch(/at most 256/)
    expect(passwordProblem('long enough!', 'long enough?')).toMatch(/do not match/)
    expect(passwordProblem('long enough!', 'long enough!')).toBeNull()
  })

  it('knows who may sign up', () => {
    expect(signupMode({ registration: 'closed', hasUsers: false }, false)).toBe('first-user')
    expect(signupMode({ registration: 'closed', hasUsers: true }, true)).toBe('closed')
    expect(signupMode({ registration: 'invite-only', hasUsers: true }, false)).toBe('needs-invite')
    expect(signupMode({ registration: 'invite-only', hasUsers: true }, true)).toBe('with-invite')
    expect(signupMode({ registration: 'open', hasUsers: true }, false)).toBe('open')
    expect(signupMode({ registration: 'open', hasUsers: true }, true)).toBe('with-invite')
  })
})

describe('admin user actions', () => {
  it('offers no password reset, admin or disable toggle on your own row', () => {
    expect(adminUserActions('me', 'me')).toEqual(['rename'])
    expect(adminUserActions('other', 'me')).toEqual(['rename', 'reset-password', 'toggle-admin', 'toggle-disabled', 'delete'])
  })
})
