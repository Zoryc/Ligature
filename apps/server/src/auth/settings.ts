import type { InstanceSettings, RegistrationMode } from '@ligature/shared'
import type { DB } from '../db/index.ts'

export const REGISTRATION_MODES: readonly RegistrationMode[] = ['open', 'invite-only', 'closed']

export function getSettings(db: DB): InstanceSettings {
  const row = db.prepare("SELECT value FROM instance_settings WHERE key = 'registration'").get() as { value: string } | undefined
  const reg = row && (REGISTRATION_MODES as readonly string[]).includes(row.value) ? row.value as RegistrationMode : 'invite-only'
  return { registration: reg }
}

export function setSettings(db: DB, patch: Partial<InstanceSettings>): InstanceSettings {
  if (patch.registration !== undefined) {
    db.prepare(`INSERT INTO instance_settings (key, value) VALUES ('registration', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(patch.registration)
  }
  return getSettings(db)
}

export function hasUsers(db: DB): boolean {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined
}
