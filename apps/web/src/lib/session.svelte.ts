import type { Me } from '@ligature/shared'
import { api, ApiError, setUnauthenticatedHandler } from './api.ts'
import { go } from './router.svelte.ts'

export const session = $state<{ me: Me | null; checked: boolean }>({ me: null, checked: false })

setUnauthenticatedHandler(() => {
  session.me = null
  go('/login')
})

export async function loadMe(): Promise<void> {
  try {
    session.me = await api.me()
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) console.error('GET /api/me failed', e)
    session.me = null
  } finally {
    session.checked = true
  }
}

export async function devLogin(username: string): Promise<void> {
  await api.devLogin(username)
  await loadMe()
}

export async function logout(): Promise<void> {
  try {
    await api.logout()
  } catch {
    // already logged out
  }
  session.me = null
  go('/login')
}
