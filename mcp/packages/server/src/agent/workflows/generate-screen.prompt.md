## Task: generate a screen

You design one new screen inside an empty board that is already on the canvas (its id, page and
size are in the request). Build it with the Penpot MCP tools, mostly `execute_code`. Never create
another top-level board and never touch layers outside that board.

Build rules:
- Reuse the file's design system first. When a library component fits (button, input, card, nav
  bar…), place an instance of it (`component.instance()`, then `parent.appendChild(instance)`) and
  change its texts; draw a new element only when no component fits.
- Colors: apply a color token (`shape.applyToken(token, ["fill"])`) or a library color
  (`shape.fills = [libraryColor.asFill()]`). Use raw hex values only when the file has neither.
- Text: apply a library typography (`typography.applyToText(text)`) or typography/font tokens.
- Spacing and radius: apply spacing / border-radius tokens when the file has them, else use a
  4 px grid.
- Layout: every container is a board with a flex layout (`addFlexLayout()`, `dir`, `rowGap`,
  `columnGap`, paddings, alignment). Children use `layoutChild.horizontalSizing` /
  `verticalSizing` (`fill`, `auto`, `fix`); no absolute positioning, so the screen stays
  responsive and can be turned into code. Nest boards for rows, sections and groups.
- Name every layer after its role, in English, Title Case ("Header", "Email Field",
  "Sign In Button"). Keep component instance names unless they are unclear. Rename the screen
  board to a short screen name ("Login", "Order Summary").
- Keep the board width. Grow its height when the content needs more room; never squeeze content.
- Real, plausible copy; no lorem ipsum. Images: a placeholder rectangle named after its content.
- Work in a few large `execute_code` calls (one per section), keeping references in `storage`.
{{#web}}
- Platform: responsive web. Desktop board; content in a centered column with a sensible max
  width, generous whitespace, pointer-sized controls.
{{/web}}
{{#mobile}}
- Platform: mobile app. Keep the status bar area (top 47 px) and the home indicator area
  (bottom 34 px) free of controls, touch targets at least 44 px high, primary action within
  thumb reach.
{{/mobile}}
{{#designer}}
- When you finish, describe the screen in one or two plain sentences, no code.
{{/designer}}
{{#developer}}
- When you finish, list the sections and the components and tokens you used, briefly.
{{/developer}}

End your answer with one line holding only this JSON (no code fence):
{"boardId": "<id of the screen board>", "name": "<screen name>"}
