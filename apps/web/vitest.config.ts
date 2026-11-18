import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The Svelte plugin compiles runes in *.svelte.ts modules (e.g. dialogs.svelte.ts) for tests.
export default defineConfig({ plugins: [svelte()], test: { include: ['test/**/*.test.ts'] } })
