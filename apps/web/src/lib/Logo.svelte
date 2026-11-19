<script lang="ts">
  /**
   * The Ligature wordmark (docs/brand): a drawn math-italic "Li" under one bar (\overline{Li}; vinculum =
   * "bond") followed by "gature" set live in Source Serif 4 Semibold. Teal only on the bar, only on light grounds.
   * In the app the wordmark is the logo; the square tile is only for the favicon and app icon.
   */
  interface Props {
    /** Font size of "gature" in px; the drawn "Li" scales with it. */
    size?: number
    /** On a dark ground: everything in paper colour. */
    reversed?: boolean
  }
  let { size = 21, reversed = false }: Props = $props()

  let li = $derived(Math.round(size * 0.952 * 100) / 100)
  let ink = $derived(reversed ? '#F4F1EA' : 'var(--ink)')
  let bar = $derived(reversed ? '#F4F1EA' : 'var(--teal)')
</script>

<span class="wordmark" style:font-size="{size}px" style:color={ink}>
  <svg width={li} height={li} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <g fill="currentColor">
      <path d="M2.94 6.01L8.92 6.01L8.72 6.98L7.08 7.29L4.7 18.64L9.74 18.64L11.12 16.54L12.17 16.54L11.44 20L0 20L0.2 19.03L1.84 18.74L4.24 7.29L2.73 6.98Z" />
      <path d="M14.57 10.13L17.3 10.13L15.84 17.06Q15.52 18.57 16.49 18.57Q17.25 18.57 18.06 17.48L18.88 17.98Q17.49 20 15.77 20Q12.49 20 13.16 16.85L14.2 11.89L12.6 11.89L12.75 11.18Z" />
      <path d="M15.27 6.01L18.32 6.01L17.7 8.95L14.66 8.95Z" />
    </g>
    <path d="M0 0H19V2H0Z" style:fill={bar} />
  </svg><span aria-hidden="true">gature</span><span class="sr-only">Ligature</span>
</span>

<style>
  .wordmark {
    display: inline-block;
    white-space: nowrap;
    font-family: var(--font-doc);
    font-weight: 600;
    font-variation-settings: 'opsz' 24;
    line-height: 1;
    letter-spacing: 0;
  }
  svg { vertical-align: baseline; }
</style>
