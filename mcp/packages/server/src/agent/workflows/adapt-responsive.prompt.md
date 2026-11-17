## Task: adapt a screen to another screen size

You get a copy of a board that was resized to a new width. Rebuild its layout so it works at that
width: reflow, do not scale. The original board stays untouched; change only the new board and
its children.

How to work:
- Read the tree you were given; use `get_node_properties` for deeper levels and
  `capture_node_screenshot` to look at your result. Use `update_design_node` for simple changes
  and `execute_code` for structure (layouts, reordering, new layers).
- Prefer flex layout on the new board and its sections: in `execute_code`,
  `board.flex ?? board.addFlexLayout()`, then `dir`, `wrap`, `rowGap`, `columnGap`, paddings,
  and `child.layoutChild.horizontalSizing = "fill"` so children follow the width. A board with a
  flex layout places its children itself: set their order instead of x/y.
- Keep component instances: resize them, change their layout sizing or switch a variant, but never
  detach them. Keep names, texts, images and colors.
- When the file has tokens (`tokens` in the tree), use them for spacing and type sizes instead of
  raw numbers.
- No child may stick out of the board's width. Text must stay readable: at least 12px, body text
  14–16px on mobile.
- Do not delete the board, do not move it, and do not change its width.

Desktop to mobile:
- Stack side-by-side columns (feature rows, cards, footer columns) into one column: rows become
  columns, grids get one column, children fill the width.
- Page padding 16–24px, gaps between sections 24–40px.
- Scale headings down (hero titles about 32–40px, section titles 24–28px).
- Navigation: when a header has more than about three links, replace them with a menu button
  (hamburger) next to the logo; keep a primary call-to-action if it fits.
- Images and media fill the width and keep their aspect ratio.
{{#mobile}}
- This is a mobile app: leave the top 47px and bottom 34px free (safe areas). For apps with a
  few main sections, a bottom tab bar fits better than a hamburger menu.
{{/mobile}}

Mobile to desktop:
- Put stacked items side by side again: cards and features in rows of two to four, footer
  columns in a row.
- Centre the content in a column of about 1200px with side padding; full-bleed sections keep
  their background across the whole width.
- Scale headings up (hero titles about 48–64px), body text 16–18px.
- Turn a menu button or tab bar back into a horizontal navigation in the header.

{{#designer}}
Reply in one short sentence, in plain words, with no technical terms.
{{/designer}}
{{#developer}}
Reply in one or two sentences; you may name the layout changes.
{{/developer}}
