import { createHash } from 'node:crypto'

/**
 * Sandbox uids of projects (the 'uid' sandbox): uid = gid, in UID_BASE .. UID_BASE + UID_RANGE - 1.
 *
 * Every project gets a uid that NO other project with a build directory has, because two projects
 * sharing a uid could read each other's files, and the post-compile sweep (kill(-1) as that uid) would
 * kill the other project's compile.
 *
 * The allocation needs no database: the owner of BUILDS_DIR/<id> IS the record. Only root creates and
 * chowns entries of BUILDS_DIR, and a project uid cannot rename or chown its directory, so the owners
 * are trustworthy. At start-up the worker reads them (UidAllocator.adopt); a new project gets the uid
 * derived from its id (preferredUid) if that is free, else the next free one.
 */
export const UID_BASE = 100_000
export const UID_RANGE = 2 ** 20

/** First choice for a project: 100000 + (first 4 bytes of sha256(projectId) as big-endian u32) mod 2^20. */
export function preferredUid(projectId: string): number {
  const h = createHash('sha256').update(projectId, 'utf8').digest()
  return UID_BASE + (h.readUInt32BE(0) % UID_RANGE)
}

export const isSandboxUid = (uid: number) => Number.isInteger(uid) && uid >= UID_BASE && uid < UID_BASE + UID_RANGE

export class UidAllocator {
  private readonly byProject = new Map<string, number>()
  private readonly byUid = new Map<number, string>()

  /** The uid recorded for a project, if any. */
  get(projectId: string): number | undefined {
    return this.byProject.get(projectId)
  }

  /**
   * Record an existing directory's owner. Returns false (and records nothing) if that uid already
   * belongs to another project or is outside the sandbox range: the caller must then reset the directory.
   */
  adopt(projectId: string, uid: number): boolean {
    if (!isSandboxUid(uid)) return false
    const owner = this.byUid.get(uid)
    if (owner !== undefined && owner !== projectId) return false
    this.release(projectId)
    this.byProject.set(projectId, uid)
    this.byUid.set(uid, projectId)
    return true
  }

  /** The project's uid, allocating a free one if it has none. Synchronous, so concurrent callers never get the same uid. */
  allocate(projectId: string): number {
    const have = this.byProject.get(projectId)
    if (have !== undefined) return have
    let uid = preferredUid(projectId)
    for (let i = 0; this.byUid.has(uid); i++) {
      if (i >= UID_RANGE) throw new Error('no free sandbox uid left')
      uid = UID_BASE + ((uid - UID_BASE + 1) % UID_RANGE)
    }
    this.byProject.set(projectId, uid)
    this.byUid.set(uid, projectId)
    return uid
  }

  release(projectId: string): void {
    const uid = this.byProject.get(projectId)
    if (uid === undefined) return
    this.byProject.delete(projectId)
    if (this.byUid.get(uid) === projectId) this.byUid.delete(uid)
  }
}
