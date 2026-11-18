import type { Services } from '../services.ts'

/** What the history service is built from (everything but itself). */
export type CoreServices = Omit<Services, 'history'>
