/*
 * The version history (docs/M3.md §1–§2). Public surface for the rest of the server (GC, admin, routes).
 */
export { createHistory, DEFAULT_HISTORY_CONFIG, type DocChangeHooks, type History, type HistoryConfig, type TakeOptions } from './history.ts'
export { captureProject, type Capture, type CapturedFile } from './snapshot.ts'
export { manifestHash } from './manifest.ts'
export { changeCounts, diffFiles, type DiffEntry } from './diff.ts'
export { DEFAULT_RETENTION, planThinning, type RetentionPolicy, type ThinCandidate } from './thinning.ts'
export {
  deleteVersions, filesOf, getVersion, isBlobInVersions, latestVersion, projectsWithVersions, thinCandidates,
  versionBlobHashes, type VersionRow,
} from './store.ts'
export { planRestore, restoreVersion, type RestorePlan } from './restore.ts'
