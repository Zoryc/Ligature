/**
 * Public surface of the server package for tools that run outside the HTTP server (e.g. src/cli.ts).
 * All functions are synchronous or return promises; none needs a running server.
 */
export { openDb, type DB } from './db/index.ts'
export { DocStore } from './collab/docStore.ts'
export { BlobStore } from './files/blobStore.ts'
export { ApiError } from './errors.ts'
export { audit, type AuditAction } from './audit.ts'
export { PASSWORD_MAX, PASSWORD_MIN, hashPassword, isAcceptablePassword } from './auth/password.ts'
export { deleteUserSessions } from './auth/sessions.ts'
export { getSettings, setSettings } from './auth/settings.ts'
export {
  countActiveAdmins, createUser, getUserById, getUserByUsername, listUsers, setPassword, type UserRow,
} from './auth/users.ts'
export { startLigature, type Ligature, type LigatureConfig } from './server.ts'
