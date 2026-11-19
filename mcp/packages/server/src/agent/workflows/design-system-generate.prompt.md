## Task: build the components of a design system

The open Penpot file is a design system: a shared library that projects will use. Its colors are
library colors and `color.<name>` tokens, its text styles are library typographies (plus
`font-size.<name>`, `font-weight.<name>`, `font-family.<name>` tokens), its radius and spacing
values are `radius.<name>` and `spacing.<name>` tokens (token set and theme "DESIGN.md"). Now
build the components the user message lists, with their variants.

Rules:

- Work on the page named "Components"; create it if it does not exist and open it
  (`await penpot.openPage(page)`). Do not change other pages.
- Build one component at a time, each in its own `execute_code` call, and wrap the code in
  `const b = penpot.history.undoBlockBegin(); try { … } finally { penpot.history.undoBlockFinish(b); }`
  so that every component is one undo step. Keep each call short (under 15 seconds).
- Give every component its states and sizes as **variants**: build one main component per
  combination, then group them with `penpotUtils.createVariantContainer([{shape, properties:
  {Type: "Primary", State: "Default"}}, …])`. Use clear property names (`Type`, `Size`,
  `State`, `Checked`…) and values (`Default`, `Hover`, `Pressed`, `Disabled`, `Focused`…).
  Name the container after the component ("Button", "Text input"…).
- Above each variant group put a short documentation text: the component name and one line on
  when to use it. Lay the groups out in a column with 80px gaps.
- Use flex layout for padding, gaps and sizing; size to content horizontally unless the spec gives
  a width.
- Apply the system's tokens and library entries: fills and strokes with color tokens
  (`token.applyToShapes(shapes, ["fill"])`) or library colors, text with
  `libraryTypography.applyToText`, radius and spacing with their tokens. Use literal values only
  where the spec has a literal.
- When a DESIGN.md key (for example `button-primary`) is implemented by a variant component, tag
  that component: `component.setSharedPluginData("penforge", "designMdComponent", "<key>")`.
- If the system needs elevation and has no shadow tokens yet, add `shadow.<name>` tokens (type
  `shadow`) to the "DESIGN.md" set first and use them. Do not create other new colors,
  typographies or tokens.
- Icons inside components: use components from the `Icons` path when the file has them; else a
  simple placeholder shape named "icon".
{{#mobile}}
- Touch targets at least 44px high.
{{/mobile}}
{{#designer}}
When you are done, say in one or two sentences what you built. No code.
{{/designer}}
{{#developer}}
When you are done, list the components and their variant properties, and anything you could not
match to the spec.
{{/developer}}
