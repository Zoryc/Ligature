export const ROLES = ['owner', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const can = {
  edit: (r: Role) => r === 'owner' || r === 'editor',
  compile: (r: Role) => r === 'owner' || r === 'editor',
  manageMembers: (r: Role) => r === 'owner',
  read: (_r: Role) => true,
}
