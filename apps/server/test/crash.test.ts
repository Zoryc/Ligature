import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName } from '@ligature/shared'
import { connect, demoProject, killHard, login, sleep, startServer, tempDataDir, waitFor, type RunningServer } from './harness.ts'

/**
 * M0 "done when": two clients co-edit, and `kill -9` of the server loses nothing.
 * These tests run the real server as a child process and SIGKILL it.
 */
describe('sync + durability (real server, SIGKILL)', () => {
  const servers: RunningServer[] = []
  const clients: { destroy(): void }[] = []
  afterEach(async () => {
    clients.splice(0).forEach(c => c.destroy())
    for (const s of servers.splice(0)) await killHard(s)
  })

  async function setup(port: number, dataDir = tempDataDir()) {
    const s = await startServer(dataDir, port)
    servers.push(s)
    const alice = await login(s.base, 'alice')
    const bob = await login(s.base, 'bob')
    const carol = await login(s.base, 'carol')
    const p = await demoProject(s.base, alice)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const docName = fileDocName(p.id, main.id, main.epoch!)
    return { s, dataDir, alice, bob, carol, p, docName }
  }

  it('two clients converge on concurrent edits', async () => {
    const { s, alice, bob, docName } = await setup(39101)
    const a = connect(s.base, alice, docName); clients.push(a)
    const b = connect(s.base, bob, docName); clients.push(b)
    await waitFor(() => a.provider.isSynced && b.provider.isSynced, 10_000, 'initial sync')
    expect(a.text().toString()).toContain('\\documentclass{article}')

    // Concurrent inserts at the same position and elsewhere.
    for (let i = 0; i < 50; i++) {
      a.text().insert(0, `A${i} `)
      b.text().insert(b.text().length, ` B${i}`)
    }
    await waitFor(() => a.text().toString() === b.text().toString() && !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges,
      10_000, 'convergence')
    const t = a.text().toString()
    for (let i = 0; i < 50; i++) { expect(t).toContain(`A${i} `); expect(t).toContain(` B${i}`) }
  }, 30_000)

  it('viewer is read-only (server drops their edits)', async () => {
    const { s, alice, carol, docName } = await setup(39102)
    const a = connect(s.base, alice, docName); clients.push(a)
    const c = connect(s.base, carol, docName); clients.push(c)
    await waitFor(() => a.provider.isSynced && c.provider.isSynced, 10_000, 'sync')
    c.text().insert(0, 'VIEWER WAS HERE ')
    a.text().insert(0, 'owner edit ')
    await waitFor(() => c.text().toString().includes('owner edit'), 10_000, 'viewer receives owner edit')
    await sleep(300)
    expect(a.text().toString()).not.toContain('VIEWER WAS HERE')
  }, 30_000)

  it('rejects a stale epoch and an unauthenticated socket', async () => {
    const { s, alice, p, docName } = await setup(39103)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const stale = connect(s.base, alice, fileDocName(p.id, main.id, main.epoch! + 1)); clients.push(stale)
    const anon = connect(s.base, 'ligature_session=nope', docName); clients.push(anon)
    await waitFor(() => stale.denied() !== null && anon.denied() !== null, 10_000, 'denials')
    expect(stale.denied()).toBe('reload-required')
    expect(anon.denied()).toBe('unauthenticated')
  }, 30_000)

  it('kill -9 with clients still connected: clients resync on reconnect, nothing lost', async () => {
    const { s, dataDir, alice, bob, docName } = await setup(39104)
    const a = connect(s.base, alice, docName); clients.push(a)
    await waitFor(() => a.provider.isSynced, 10_000, 'sync')
    for (let i = 0; i < 200; i++) a.text().insert(a.text().length, `line ${i}\n`)
    await waitFor(() => !a.provider.hasUnsyncedChanges, 10_000, 'acked')
    const expected = a.text().toString()

    await killHard(s) // immediately: some updates may still be in the 200 ms write buffer
    const s2 = await startServer(dataDir, 39104); servers.push(s2)
    // The original client reconnects by itself and its state-vector sync re-sends anything the server lost.
    await waitFor(() => a.provider.isSynced && !a.provider.hasUnsyncedChanges, 15_000, 'client reconnect')
    const fresh = connect(s2.base, await login(s2.base, 'bob').catch(() => bob), docName); clients.push(fresh)
    await waitFor(() => fresh.provider.isSynced, 10_000, 'fresh sync')
    await waitFor(() => fresh.text().toString() === expected, 5_000, 'fresh client sees all text')
  }, 60_000)

  it('kill -9 with no client left to resync: the update log alone restores everything', async () => {
    const { s, dataDir, alice, docName } = await setup(39105)
    const a = connect(s.base, alice, docName)
    await waitFor(() => a.provider.isSynced, 10_000, 'sync')
    for (let i = 0; i < 300; i++) a.text().insert(a.text().length, `edit ${i}\n`)
    await waitFor(() => !a.provider.hasUnsyncedChanges, 10_000, 'acked')
    const expected = a.text().toString()
    await sleep(400) // > 200 ms flush interval: the log batch is committed
    await killHard(s) // doc never unloaded/compacted: only the log has the edits
    a.destroy()       // the client is gone too, so it cannot re-send anything

    const s2 = await startServer(dataDir, 39105); servers.push(s2)
    expect(s2.output()).toMatch(/recovered \d+ doc/)
    const fresh = connect(s2.base, await login(s2.base, 'alice'), docName); clients.push(fresh)
    await waitFor(() => fresh.provider.isSynced, 10_000, 'fresh sync')
    expect(fresh.text().toString()).toBe(expected)
  }, 60_000)

  it('client leaves (doc compacted on unload), then kill -9: snapshot restores it', async () => {
    const { s, dataDir, alice, docName } = await setup(39106)
    const a = connect(s.base, alice, docName); clients.push(a)
    await waitFor(() => a.provider.isSynced, 10_000, 'sync')
    a.text().insert(0, '% persisted by the log\n')
    await waitFor(() => !a.provider.hasUnsyncedChanges, 10_000, 'acked')
    const expected = a.text().toString()
    a.destroy()
    await sleep(500) // unload -> compaction into doc_state
    await killHard(s)
    const s2 = await startServer(dataDir, 39106); servers.push(s2)
    expect(s2.output()).not.toMatch(/recovered \d+ doc/)
    const fresh = connect(s2.base, await login(s2.base, 'alice'), docName); clients.push(fresh)
    await waitFor(() => fresh.provider.isSynced, 10_000, 'fresh sync')
    expect(fresh.text().toString()).toBe(expected)
  }, 60_000)
})
