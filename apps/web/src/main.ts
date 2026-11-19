import { mount } from 'svelte'
import App from './App.svelte'
// Fonts are bundled with the app (no third-party font requests from a self-hosted server).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource-variable/source-serif-4/opsz-italic.css'
import './app.css'

const target = document.getElementById('app')
if (!target) throw new Error('#app not found')

export default mount(App, { target })
