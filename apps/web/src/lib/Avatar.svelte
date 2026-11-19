<script lang="ts">
  import { initials, userColor } from './colors.ts'

  /** A person: square initials in their presence colour (squares are people; the logo is never a square). */
  interface Props { id: string; name: string; size?: number; title?: string }
  let { id, name, size = 22, title }: Props = $props()
  let color = $derived(userColor(id).color)
</script>

<span class="avatar" aria-hidden="true" {title} style:background={color} style:width="{size}px" style:height="{size}px"
  style:font-size="{Math.max(8.5, size * 0.42)}px">{initials(name)}</span>
