/** Which per-user actions the admin page offers for a row. Pure, so it can be unit-tested. */

export type AdminUserAction = 'rename' | 'reset-password' | 'toggle-admin' | 'toggle-disabled' | 'delete'

/**
 * For your own row: no reset (the server would end all your sessions, this one included: change it on
 * the Account page instead), no admin/disable toggles (you would lock yourself out), and no delete (the
 * server refuses it: you delete your own account on the Account page, with your password).
 */
export function adminUserActions(userId: string, meId: string): AdminUserAction[] {
  return userId === meId ? ['rename'] : ['rename', 'reset-password', 'toggle-admin', 'toggle-disabled', 'delete']
}
