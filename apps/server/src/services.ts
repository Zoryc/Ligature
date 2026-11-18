import type { DB } from './db/index.ts'
import type { DocStore } from './collab/docStore.ts'
import type { Collab } from './collab/collab.ts'
import type { BlobStore } from './files/blobStore.ts'
import { DEFAULT_ZIP_LIMITS, type ZipLimits } from './zip/reader.ts'

export interface Limits {
  /** live nodes per project (files + folders, root excluded) */
  maxFiles: number
  /** total bytes of live binary files per project */
  maxBinaryBytes: number
  /** one upload request body */
  maxUploadBytes: number
  /** one zip import request body (docs/M2.md §5) */
  maxImportBytes: number
  /** limits enforced while reading an imported zip */
  zip: ZipLimits
  /** trash batches older than this are purged automatically (docs/M2.md §1) */
  trashRetentionMs: number
}

export const DEFAULT_LIMITS: Limits = {
  maxFiles: 2000,
  maxBinaryBytes: 500 * 1024 * 1024,
  maxUploadBytes: 50 * 1024 * 1024,
  maxImportBytes: 100 * 1024 * 1024,
  zip: DEFAULT_ZIP_LIMITS,
  trashRetentionMs: 30 * 24 * 60 * 60 * 1000,
}

/** Everything the domain services need. One instance per running server. */
export interface Services {
  db: DB
  store: DocStore
  collab: Collab
  blobs: BlobStore
  limits: Limits
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isUuid = (s: string | undefined | null): s is string => typeof s === 'string' && UUID_RE.test(s)
