import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import { openDb } from '../src/db/index.ts'
import { MIGRATIONS } from '../src/db/schema.ts'
import { applyTextDiff } from '../src/collab/textDiff.ts'
import { classifyUpload, extensionOf, inlineImageType } from '../src/files/classify.ts'
import { BlobStore } from '../src/files/blobStore.ts'
import { RateLimiter } from '../src/http/rateLimit.ts'
import { createSession, sessionForToken } from '../src/auth/sessions.ts'
import { createUser, setPassword } from '../src/auth/users.ts'
import { verifyPassword } from '../src/auth/password.ts'
import { nodePaths } from '../src/projects/repo.ts'
import { subtreeIds } from '../src/files/tree.ts'

describe('textDiff', () => {
  it('property: any from -> to, applied to a Y.Text, yields `to`; a concurrent peer converges', () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), fc.string({ maxLength: 5 }), (from, to, peer) => {
      const a = new Y.Doc(); const b = new Y.Doc()
      a.getText('t').insert(0, from)
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
      a.transact(() => applyTextDiff(a.getText('t'), from, to))
      expect(a.getText('t').toString()).toBe(to)
      b.getText('t').insert(0, peer)
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
      expect(a.getText('t').toString()).toBe(b.getText('t').toString())
      expect(a.getText('t').length).toBe(peer.length + to.length)
    }), { numRuns: 500 })
  })

  it('handles astral characters and is minimal (one edit for one changed word)', () => {
    const d = new Y.Doc(); const t = d.getText('t')
    t.insert(0, 'a \u{1F600} b c')
    let updates = 0
    d.on('update', () => updates++)
    const ops = d.transact(() => applyTextDiff(t, t.toString(), 'a \u{1F600} B c'))
    expect(t.toString()).toBe('a \u{1F600} B c')
    expect(ops).toBe(2)
    expect(updates).toBe(1)
    expect(applyTextDiff(t, t.toString(), t.toString())).toBe(0)
  })
})

describe('classify', () => {
  it('extensions, allow-list, UTF-8, size', () => {
    expect(extensionOf('a.TeX')).toBe('.tex')
    expect(extensionOf('.latexmkrc')).toBe('')
    expect(extensionOf('noext')).toBe('')
    expect(classifyUpload('a.tex', Buffer.from('x'))).toEqual({ kind: 'text', text: 'x' })
    expect(classifyUpload('a.bbl', Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ kind: 'text', text: 'A' })
    expect(classifyUpload('a.tex', Buffer.from([0xed, 0xa0, 0x80]))).toEqual({ kind: 'binary' }) // lone surrogate
    expect(classifyUpload('a.tex', Buffer.from([0xc0, 0xaf]))).toEqual({ kind: 'binary' }) // overlong
    expect(classifyUpload('a.png', Buffer.from('text'))).toEqual({ kind: 'binary' })
    expect(classifyUpload('a.tex', Buffer.from('a\r\nb\rc'))).toEqual({ kind: 'text', text: 'a\nb\nc' })
    expect(inlineImageType('x.SVG')).toBeNull()
    expect(inlineImageType('x.JPEG')).toBe('image/jpeg')
  })
})

describe('RateLimiter', () => {
  it('fixed window per key', () => {
    let now = 0
    const rl = new RateLimiter(2, 1000, () => now)
    expect(rl.consume('a')).toBe(true)
    expect(rl.consume('a')).toBe(true)
    expect(rl.consume('a')).toBe(false)
    expect(rl.consume('b')).toBe(true)
    now = 1000
    expect(rl.consume('a')).toBe(true)
    rl.hit('c'); rl.hit('c')
    expect(rl.blocked('c')).toBe(true)
    rl.reset('c')
    expect(rl.blocked('c')).toBe(false)
  })
})

describe('BlobStore', () => {
  it('content-addressed, atomic (no temp files left), idempotent, recorded in the blobs table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ligature-blobs-'))
    const db = openDb(':memory:')
    const bs = new BlobStore(db, dir)
    const h = bs.put(Buffer.from('hello'))
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(existsSync(join(dir, '2c', h.slice(2)))).toBe(true)
    expect(bs.put(Buffer.from('hello'))).toBe(h)
    expect(readdirSync(join(dir, '2c'))).toEqual([h.slice(2)])
    expect(readFileSync(bs.pathOf(h), 'utf8')).toBe('hello')
    expect(db.prepare('SELECT size FROM blobs WHERE hash = ?').get(h)).toEqual({ size: 5 })
    expect(bs.read('0'.repeat(64))).toBeNull()
    expect(() => bs.pathOf('../etc/passwd')).toThrow()
  })
})

describe('migration 2', () => {
  it('upgrades an M0 database: backfills timestamps, first user becomes admin, keeps data', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ligature-mig-')), 'app.db')
    const raw = new Database(file)
    raw.exec(MIGRATIONS[0]!)
    raw.pragma('user_version = 1')
    raw.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES ('u1', 'alice', 'Alice', 100), ('u2', 'bob', 'Bob', 200)").run()
    raw.prepare("INSERT INTO projects (id, name, root_id, created_at) VALUES ('p1', 'P', 'r1', 50)").run()
    raw.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u1', 'owner')").run()
    raw.prepare("INSERT INTO files (id, project_id, parent_id, name, kind, created_at) VALUES ('r1', 'p1', NULL, '', 'folder', 60)").run()
    raw.close()
    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT username, is_admin AS a, disabled_at AS d FROM users ORDER BY username').all())
      .toEqual([{ username: 'alice', a: 1, d: null }, { username: 'bob', a: 0, d: null }])
    expect(db.prepare('SELECT updated_at AS u, deleted_at AS d FROM projects').get()).toEqual({ u: 50, d: null })
    expect(db.prepare('SELECT added_at AS a FROM project_members').get()).toEqual({ a: 50 })
    expect(db.prepare('SELECT updated_at AS u FROM files').get()).toEqual({ u: 60 })
    for (const t of ['instance_settings', 'invites', 'blobs', 'audit_log']) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toBeDefined()
    }
    db.close()
    expect(openDb(file).pragma('user_version', { simple: true })).toBe(MIGRATIONS.length) // idempotent reopen
  })
})

describe('auth services (used by the CLI)', () => {
  it('createUser / setPassword / sessions of disabled users are invalid', async () => {
    const db = openDb(':memory:')
    const u = await createUser(db, { username: 'Admin', displayName: 'Admin', password: 'long enough pw', isAdmin: true })
    expect(u).toMatchObject({ username: 'admin', isAdmin: true })
    await expect(createUser(db, { username: 'admin', displayName: 'x', password: 'long enough pw' })).rejects.toMatchObject({ code: 'username-taken' })
    await expect(createUser(db, { username: 'x1x', displayName: 'x', password: 'short' })).rejects.toMatchObject({ code: 'weak-password' })
    const s1 = createSession(db, u.id); const s2 = createSession(db, u.id)
    expect(sessionForToken(db, s1.token)?.user.isAdmin).toBe(true)
    expect(await setPassword(db, u.id, 'another long pw')).toBe(2)
    expect(sessionForToken(db, s1.token)).toBeNull()
    expect(sessionForToken(db, s2.token)).toBeNull()
    const row = db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(u.id) as { h: string }
    expect(row.h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(await verifyPassword(row.h, 'another long pw')).toBe(true)
    const s3 = createSession(db, u.id)
    db.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(u.id)
    expect(sessionForToken(db, s3.token)).toBeNull()
  })
})

describe('tree helpers', () => {
  it('nodePaths and subtreeIds', () => {
    const rows = [
      { id: 'r', parentId: null, name: '' }, { id: 'a', parentId: 'r', name: 'a' },
      { id: 'b', parentId: 'a', name: 'b.tex' }, { id: 'c', parentId: 'r', name: 'c' }, { id: 'o', parentId: 'gone', name: 'o' },
    ]
    const p = nodePaths(rows)
    expect(Object.fromEntries(p)).toEqual({ r: '', a: 'a', b: 'a/b.tex', c: 'c' })
    expect(subtreeIds(rows, 'a').sort()).toEqual(['a', 'b'])
  })
})
