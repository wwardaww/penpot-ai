# Cards

## Why theirs look expensive

1. The card is barely there: one step off the page, a hairline, generous padding. The colour is
   inside the panel.
2. The panel holds a real, lit picture (a painted landscape, a grain field, a mesh, satin), never a
   flat two-stop gradient and never a pattern of lines or dots. On a dark page it is the brightest
   thing in the card: x.ai puts a daylight painting behind its dark UI.
3. The UI on it is a real product at true size, cut by the panel's edge: a glimpse of something
   bigger, not a toy floating in the middle.
4. One thing moves per card group, inside a panel (tech pages). The card never moves by itself; a
   card with a link lifts 2px on hover (`motion.md`).
5. Everything lines up: panel edge with text edge, radii nested, titles level across a row.

## The card

- Fill `--card`, one clear step off the page (light: white on `#f3f3f1`; dark: `#151517` on
  `#070708`, as x.ai's dark cards read against their page), or no border at all when the photograph
  or flat fill is the card.
- Border 1px, ink at 8 to 14%; inner top highlight 1px (white 5-7%, dark only). No blurred shadow at
  rest (a hard zero-blur offset is allowed as the rest style); a card with a link may show a soft
  shadow on hover only (`motion.md`). A card with a link lifts 2px on hover; a card without one
  carries `.m-nolift`. Never tilted, never a carousel: rows show whole cards; press quotes stack.
- Rows on the grid: two-up 6+6, three-up 4+4+4, four-up 3+3+3+3, the first card on the left line,
  the last on the right, one height per row, every row full (`layout-v4.md` section 4).
- Radius `--r-lg` (20 on `soft`; 18 on a phone). Padding 32 from 1024px, 28 below, 24 on a phone:
  never under 24, and the text always inside it. A filled split panel pads 48.
- Title one line at the card-title token (20/18), weight 500. 8px, then at most two lines at 16/24
  in the ink (`--c-text`, 84% ink: never small grey text), at most 46ch. All running text in a card
  is 16/24 in that ink: points, the line under a stat, plan lines and lists, a quote's name and role, a
  result's bar labels. Muted small text is for labels only (a price's "/ month", a section tag).
  `.card--row` holds the lines at 2 from 1024px so titles and panels line up across a row.
- 32px from the last line to the panel. One `--p-h` per card group (page CSS), and a phone value beside it when
  the group's tiles stack into a two-screen section (`@media (max-width: 639px) { #features .panel { --p-h: 180px } }`
  holds four tiles of two lines each in two phone screens).

## Two levels, never three

A card holds a picture, and the picture holds the product. That is all:

- **card > panel (a lit picture) > fragment.** The panel must read as a picture, not as a box: a
  soft field with no border lines, grid, ruling or dots of its own, so the fragment sits *on a
  picture*, not in a frame in a frame.
- Never card > patterned panel > white UI card (in testing, "card, grid-paper panel, white UI card"
  read as three nested boxes). Never a fragment that is itself a card holding cards of text.
- Never a card inside a card for text, never glass.

## The panel

- Default (x.ai): side edges on the text column, runs off the card's bottom edge, top radius 12,
  the lower 60-65% of the card (`--p-h` 264-340px).
- `.panel--inset`: even 8px margin; radius = card radius - margin (20 - 8 = 12), never under 6,
  so the corners read as one family. Every panel in a row has one ratio (4:3 or 16:10) and one
  inset. A smaller UI card on a panel is solid (never frosted), 40 to 60% of the panel's width,
  offset so the panel's bottom or right edge cuts it.
- `.panel--flush`: runs to the card's side and bottom edges (Figma's image band).
- `.panel--top`: on top with an 8px margin, the card's lines below (tall cards).
- `.panel--device`: a status row on the card itself (app, muted context, a quiet status with a
  still dot), then the ground as its screen, radius 12, running off the bottom: x.ai's "Computer"
  card. The row is not a frame of its own (a filled device frame made a fourth box).
- A 1px inner edge (`::after`) sits over the ground and over any fragment it cuts.
- The vignette (`::before`: `--vx`, `--vy`, `--calm-k`) calms the ground where the fragment sits.
  On a lit ground set `--calm-k: 0%` and use the effect's own `calm` params.

## The fragment on it

- **The product's own subject**: the fragment shows what this product works on, as its
  users see it. A code-review tool shows a real diff, red and green, with the comment and its
  Accept or Apply action (`diff-review`); an invoicing app an invoice; a booking app its calendar; a
  CI product its pipeline (`pipeline-board`, `terminal-run`). Never a generic dashboard, chat or stat
  card standing in for it; when no fragment shows the subject, build it from the client's screens. Cards show parts; the product is shown whole once, big, in an `app-frame` (`sections-library.md`:
  `window` as the list beside the open item, one window across the `.wrap`). A software page whose
  product appears only as small fragments centred on coloured panels reads as fragments, not as
  the product (in testing: about 3.5 points under Linear). A gaming page takes no fragment at all: it shows the game (`sections.md`, Gaming).
- The product's real UI as live HTML at true size, complete and legible, never a flat picture:
  13px text, 12px meta, never under 11px; weights 400 and 500. Real data (names, amounts, order
  numbers, times) and real app marks (`icons.md`). Each fragment keeps its minimum width (chat
  140, checklist 160, slider 215, toggles 230, search 240, terminal-run 280, calendar 280, stat 285,
  cursor 290, files 300, diff-review 280, pipeline-board 280, notify 340, code 365, doc 400, window 456).
  A phone mock or UI card runs past its panel
  only where the panel clips it, never past `.wrap`.
- Surface white on light, `#1c1d20` on dark (one step lighter than the `#151517` card; `--frag`
  sets it); 1px border at 12%; radius 12; the layered shadow lives only inside the panel.
- The primary button is the ink; switches that are on are ink; the product's own mark
  (`.ui-agent`) is ink. **The accent appears once per fragment**: the row being worked on, the
  marked date, the marked line's bar, the last bar, the slider being dragged. A range, keywords,
  numbers, today's dot and status chips are ink tints. Never a row of green dots.
  - `.at-corner`: 28-40px from the top-left, cut by the right and bottom (19 of 41 sites).
  - `.at-rise`: starts 24-56px down and leaves through the bottom (chat, voice, a calendar).
  - `.at-right`: anchored top-right; it narrows on a small panel rather than cut its text.
  - A short stack (notify) sits low: `--ay` and `--ay-sm` `calc(100% - 180px)`, its last row cut.
  - `.at-over`: a second fragment over the first one's lower-right edge. The `cursor` dialog only
    ever sits here, over a window: never alone on a ground, never centred.
  - `.at-center`: only a small control (at most about 250 x 130) on a focal tile: the compact
    slider driving its ground (Figma's Texture tile). Never a window or a dialog.
  - `.wide` + `--w`: a fluid grid (files) set wider than the panel, so it is cut by the right
    edge like a window; it always runs 64px or more past it.
  - `.to-edge`: the wrapper reaches 72px past the bottom, whatever the panel's height; `chat`,
    `doc`, `stat` (`fill`) and `voice` grow into it, so they are always cut, never a few px short.
  - Developer tools (tech and software pages only; all three lay themselves out for the width they
    get, so none is ever sliced):
    - `diff-review` (a code review on a diff): `.at-corner.fit` (or `.at-rise.fit` in a wide panel)
      with `--fit-max: 480px` (up to 760px wide), 32-40px in, cut by the bottom with `.stage--fade-b`:
      the reviewed line, its suggestion, the comment and the Apply button stay in the top 250px, and
      the diff runs two context lines further, so a 352px panel at 36px down cuts it by 32px or more
      at every width (never leave less than 24px of it past the edge). Never cut it by the right edge.
      Under 440px it keeps one gutter and drops the function name from the hunk header; on a phone give
      its panel 340px or more. The file's real mark (TypeScript) sits on a light tile in its header.
      The accent is the short bar beside the comment's text, set in from the comment's edge.
    - `terminal-run` (a test run in a terminal): `.at-rise.fit` with `--fit-max: 440px`, 32-40px in
      and 32-40px down, always whole with 24px or more of ground under it (a 352px panel at 40px
      down). Never cut or faded: the status line with its green check sits one row above the bottom.
      In a wide panel or a split card `--fit-max` goes up to 560px (the path column stops at 28
      characters). The counts go under 380px; the branch and the repo's parent folder under 300px.
      The status check is the one green and the strongest mark; the meter's thin bar is the one
      accent; the per-file ticks stay ink.
    - `pipeline-board` (a CI run on a rail of steps) sits whole: `.at-rise.fit` with
      `--fit-max: 420px`, 32-40px down, 24px or more of ground under it and no fade, since the
      running step reaches the last row. In a large panel or a split card it goes `.at-corner.fit`
      at its full width (680px or more), where it becomes a row of nodes with a log about 300px
      tall, and the bottom-right corner stays clear for the pause button. The cycle
      starts and ends on the markup as written, so write the picture to rest on (the run part done).
- Vary the placements across a group: a 2x2 shows at least three (rise, corner or device, a low
  stack, right). Never one card layout four times.

## Edges and fades

- Every edge keeps 24px of ground or is cut by 24px or more (16px a side on a phone, by design).
  A cut never slices text: `.stage--fade-b`, `--fade-r`, `--fade-br` dissolve the last
  `--fade-h` (64px; 40px on a short panel such as the tall cards) into the ground.
- **A fade never crops the point.** It only covers context: the row below the one that changes,
  a chat's input, a page's later paragraphs, a list's last rows. The thing the card is about (the
  row being worked on, the connecting app, the number, the button, the orb and its transcript line) sits
  above `100% - --fade-h`. Put the moving row near the top (the integrations target third, not
  last), or lower the fragment's start, or shorten the fade.
- A fade only where an edge cuts: a fragment that keeps 24px of ground on a side has no fade on
  that side (`--fade-br` on a window that ends inside the panel fades it for nothing).

## Never

- A big fragment dead centre with even ground all round; a dialog alone on a ground.
- Three levels of boxes: a card, a patterned panel, a white card on it.
- A pattern (grid, ruling, contours, dots) behind a window or a list.
- A fade over the point of a fragment; a sliver of 1-23px at any edge.
- A dark ground behind dark UI on a dark page.
- The accent on every chip, date and keyword; brand colours mixed with ink marks; glossy 3D blobs.
- A loop over 5 s with no pause button; a spinner, caret or pulse running on in a still picture.
- A card or panel that moves with scroll or lights up when it scrolls into view.
- A "sample", "example" or "to follow" note anywhere, even one line in the footer (in testing:
  "Names and figures on this page are examples" read as an apology), a caption under a visual
  that explains or apologises, and a placeholder (`[Name]`, `Example Street 1`, a `.example`
  address, lorem ipsum). Licence credits go in one footer line.
- Small grey card text (15px muted): card text is 16px in the ink.
