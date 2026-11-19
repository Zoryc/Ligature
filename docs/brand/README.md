# Ligature logo (Vinculum)

The logo is the word **L̄igature**. The first two letters are a drawn math-italic *Li*, bound under one bar, the way
TeX sets `\overline{Li}`. *Vinculum* is Latin for "bond", which is also what a ligature is. The rest of the word is
Source Serif 4 Semibold. Every file here is pure SVG paths: no fonts, no scripts, no external references.

## Files

| File | Use |
|---|---|
| `ligature-wordmark.svg` | Primary logo on paper or any light ground. Ink letters, teal bar. Display cut: use at 40 px font size and up (artwork 45 px tall or more). |
| `ligature-wordmark-small.svg` | The same logo in the text cut (heavier stems and serifs, Source Serif 4 at opsz 21). Use from 18 to 40 px font size (artwork about 21 to 46 px tall). |
| `ligature-wordmark-reversed.svg` | On ink or any dark ground. Letters and bar are both paper. |
| `ligature-icon.svg` | Square app icon, scalable master (160-unit grid). Use it for 48 px and up: PWA, desktop, docs. |
| `favicon-32.svg` | 32 px tab icon. The bar is snapped to whole pixels. |
| `favicon-16.svg` | 16 px favicon, drawn on the pixel grid. Ink tile, paper letters, paper bar. |
| `favicon-dark-16.svg` | 16 px favicon for dark browser chrome. Paper tile, ink letters, teal bar. |

Font-size and artwork height relate as: wordmark height = 1.12 × font size (display file), 1.16 × font size (small file).

## Colours

| Name | Hex | Role |
|---|---|---|
| Ink | `#1E1C19` | Letters on paper; ground of the tile and of reversed use |
| Paper | `#F4F1EA` | Ground; letters and bar on ink |
| Teal | `#0E5A57` | The bar, and nothing else |

**One colour rule.** Teal appears only on the bar, and only on paper or another light ground. On ink, the whole logo
goes paper, bar included. Teal never sits on ink. The one-colour version (bar in ink) is always allowed.

## Wordmark in the app, tile for icons

- Inside the product (the Folio top bar, the sign-in page, docs headers) always use the **wordmark**. Never put the
  *Li* tile in the logo slot: next to the user squares (BO, CN, AM) a two-letter square reads as another avatar.
- In the app's top bar the lockup is HTML: the drawn *Li* with its bar as inline SVG, followed by "gature" as live
  text in Source Serif 4 Semibold, at 21 px, on the same baseline as the project title. Under 40 px the drawn *Li*
  is snapped to whole pixels (21 px: 2 px bar, 4 px gap) so the bar stays crisp.
- The **tile** is only for the app icon, the favicon and the tab icon. Use the 16 and 32 px files at exactly those
  sizes; do not scale the master down to them.

## Clear space and minimum sizes

- Clear space: one cap height of the *L* on every side of the wordmark (0.67 × font size; 66.6 units in the
  display file's viewBox). Nothing else (text, rules, edges) inside it.
- Minimum wordmark: 18 px font size (about 21 px tall) with the small file. Smaller than that, use the tile.
- Minimum tile: 16 px, with `favicon-16.svg` only.
- The tile has its optical margins built in (about 14% on each side). The OS may round its corners; do not add
  rounding or padding yourself.

## Proportions (fixed at every size)

- Bar length = ink width of *Li*, from the left foot of the *L* to the right end of the *i*.
- Bar thickness = ⅝ of the *L* stem. Gap from bar to cap line = 2 × bar thickness.
- Slant of the drawn *Li*: 12°. The dot of the *i* is square.

## Don'ts

- Don't set *Li* in a font, or type `\overline{Li}`, as a substitute for the drawn letters.
- Don't use the *Li* tile inside the app UI, or next to user avatars.
- Don't put the teal bar on ink, and don't colour the letters teal.
- Don't recolour, outline, stretch, rotate, add shadows, gradients or glow, or round the tile's corners.
- Don't change the bar length, thickness or gap, or move the bar off the *Li*.
- Don't use the display wordmark below 40 px font size (it turns grey and thin), or the small one above about 48 px
  (its heavier serifs look clumsy at display size).
- Don't letter-space the wordmark, set it in all caps, or split *Li* and "gature" across lines or colours.

## Licence

The logo artwork in this folder is part of Ligature (MIT). The "gature" outlines were traced from
**Source Serif 4** (Adobe, SIL Open Font License 1.1), which permits using the typeface in logos and artwork;
no font file is distributed here. The design exploration (all logo rounds and the Folio interface mockups) lives on
the project's design canvas.
