/**
 * Validation for a single file/folder name (one path segment) and for a relative project path.
 * Shared by the app (tree ops) and the compiler (defence in depth before touching disk).
 */
export const MAX_NAME_LEN = 255
export const MAX_PATH_LEN = 1024
export const MAX_DEPTH = 32

// Control chars, slash, backslash, and characters that are troublesome on common filesystems or in TeX.
const BAD_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/

export function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LEN) return false
  if (name === '.' || name === '..') return false
  if (BAD_CHARS.test(name)) return false
  if (name !== name.trim()) return false
  return true
}

export function isValidRelPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LEN) return false
  const parts = path.split('/')
  if (parts.length > MAX_DEPTH) return false
  return parts.every(isValidName)
}
