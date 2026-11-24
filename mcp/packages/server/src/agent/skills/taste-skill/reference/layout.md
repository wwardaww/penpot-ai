# Layout: one section per screen, equal edges, heroes, type

## 1. What the good sites do

- figma.com and x.ai (the reference recording): the hero fills the first screen and nothing of the next
  section shows at load; sections hold 0.45 to 1.25 screens of content with about a quarter screen
  between them. Both still show a neighbour in a shot of one section: the look the house asks us to go
  past.
- A study of 327 sites at 1440x900 and 390x844: the hero is alone on the first screen on 78% of
  company sites; a section shows alone more often the taller it is (0.29 under 0.6 screens, 0.80
  at 0.95 to 1.1) and the wider the gap (0.42 under 60px, 0.82 at 220px and more). Its place sample
  holds no local shops, so the place numbers below are the house's own ask and taste, not measurements.
- So the look comes from heights and padding only: every section is exactly one or two screens.

## 2. One section per screen

**The judge tile.** The "shot" is the screen at scrollY = k x H (k x 900 at 1440x900, k x 844
at 390x844). Every tile shows exactly one section, the hero included. Plan the page as a list of
screens before building. `html { scroll-padding-top: 0; scroll-behavior: auto }`, so an anchor jump
lands on a tile (the fixed header covers the top of the section's padding).

**The shell.** No popups, newsletter modals, chat bubbles, help
pills, back-to-top squares, badges, award strips or asks in a modal; nothing else is fixed.

**The section box.** `.wrap` is a section's only
in-flow child (`z-index: 1`); a layer sits beside it.

**Content windows** (content height c, the h2's top to the last content's bottom; one screen holds
708px at 1440x900, y 120 to 828):

| c at 1440x900 | Screens |
|---|---|
| under 360 | merge into the section above, or add the picture it lacks |
| 360 to 495 | one screen, a warning: give it its picture |
| 495 to 708 | one screen |
| 708 to 1,320 | no height fits: cut to 708, split into two sections (each 495+ with its own h2), or `.g2` |
| 1,320 to 1,608 | two screens (1,200 to 1,320 warns) |
| over 1,608 | split |

At 390 (`--padt` 96, `--padb` 48 plus the bar): one screen holds 464 to 700 - bar, two hold 1,268
to 1,544 - bar; between, use `.g2m` or cut the phone copy. Split or cut a long feature grid; never
shrink it.

**The tablet (640 to 1023; the judges hold it upright at 768x1024 and 820x1180).** There the box
grows past its screens rather than overlap, so a section a little too tall pushes every later
section off the screen grid and each tile shows one section's tail and the next one's head, cards
cut by the tile's edge (seen at 768). Stacked content c at 768x1024 (the stricter):

| c at 768x1024 | Do |
|---|---|
| up to 832 | one screen |
| 832 to 1,130 | cut to one screen: a lower `--p-h` for the group at tablet, the split's frame as `.fill` (it takes what is left), the grey line or a fourth card out |

- **Two screens as two groups:** `.g2` (or `.g2m`, phone only) makes the `.wrap` two rows, each at
  most 708px; row 1 holds the h2 and the first group (360 to 708), row 2 the rest (420 to 708) with
  no second h2, starting `--padt` under the second screen's top, so the second tile looks like any
  other section. A total of 708 to 780 has no legal height: add or cut up to 72px.
- **Top-aligned:** the one h2 is the first content, `--padt` (120, 96 on a phone) under the section
  top, 48 under the header in the tile, like the hero's h1. Never centre content vertically; never a
  second h2.
- **Fill** 0.55 or more; the gap to the next content is then 2 x padding at least (192px; 144 + bar
  on a phone). A short block is merged or given its picture, never centred alone in an empty screen.
  A quote, logo row, stat row or FAQ that alone holds under 495px (464 at 390) merges into the
  section above as its last element, with no heading or ground of its own. No strip sections.
- **Separation** by a full-width ground change or space only: no rules, shadows or inner hairlines
  between or inside sections, and no inset coloured box standing in for a ground. A list may close
  each row with a 1px rule inside the content edges.
- **The close and the footer are one section,** `footer.closing` (one screen; `.g2m` allowed on a
  phone): `footer.closing > .wrap` holds exactly two children, row 1 the dealt close and row 2 the
  links and the legal row. No separate closing band.
- **No scroll tricks:** no scroll-snap, scroll-jacking or smooth-scroll library. Nothing else on any page is sticky.

## 3. The hero

- **The h1** first, top at y 120 (96 on a phone), at most three lines at every width, never
  smaller than an h2 (28 to 60px on a phone). A notice line (one 14px line in the body face with a
  number, 4.5:1: changed hours, a delivery cut-off) sits 16px above it; never a bar above the header.
- **The picture ends inside the hero:** a layer behind the words, beside them in a split, or above
  or below them only if the whole hero ends by H - 24. A frame under the words ends by y 836 (about
  296px under a 356px text block); larger becomes a layer. Never a first screen that ends on a
  visual cut by the fold, never half a picture under the text.
- **The first screen at 768 and 820.** The split stacks: the words, then the picture in what is
  left. Its bottom edge ends on a whole element or clearly bleeds a large picture on purpose:
  - whole: the picture (a fragment, a phone, a render) ends 24px or more above the hero's foot;
  - a bleed: a photograph or ground filling its frame (`.frame--photo`, `object-fit: cover`), or a
    fragment in `.frame > .stage` cut by the frame's bottom through 96px or more of its rows under
    `.stage--fade-b`, the point (the comment, the button, the row worked on) above the fade. Below 1024 `.at-over` pieces hide; give the main piece a `.fit` width
  (it narrows), never a fixed one. Shoot 820x1180 and 768x1024 and read the first screen's foot.
- **Docked strip:** software and product may dock one row under the hero's content (real customer
  logos with permission, a rating line the brief gives, or three facts), at most 96px, still, hidden
  on a phone unless it ends by H - 24 - bar. Service and place dock nothing.
- **Phone:** the text first; a photograph above it only when the whole hero ends by H - 24 - bar.
  Hero buttons stack at one width, unless both fit on one line.
- **Allowed types:** a full-bleed still photograph, a product whole on a stage, an inset frame, a
  statement followed by the work. Tech only: a film in a frame or behind the text (muted, inline,
  poster first, a pause button: the page's effect or loop) or a 3D hero (poster first, the canvas
  swapped in when ready). On other a film is a still that plays on a click.
- **Pictures in the hero are the work:** the client's product, place or work, never a colour field
  or a mood.

### The eleven heroes

Dealt by kind and by the material the brief really has, never by taste, never the same within three
pages; a place never deals (the place hero below):

It prints the hero (its demo, numbers, and the moment, ground and effect ids that fit the kind; on
other only the hero itself counts). `word` and `statement` are
dealt only without a strong photograph.

| id | composition at 1440 | at 390 | its motion |
|---|---|---|---|
| `split` | text span-5; the picture span-6 start-7, top-aligned with the h1, ending on the right line; one opaque float card on its lower left | text, then the picture (at least 240 tall) | the float card's dot (tech) |
| `photo` | a full-bleed photograph layer, the words on its calm, dark side on six columns (h1 80, two lines), four facts at the foot | the photograph cut to the top, the words under it on the ground | none |
| `editorial` | the headline is the picture: 156px on three lines across the wrap, one or two photographs set in the line as pills | 56px on four lines | the pills open once on load (tech); still elsewhere |
| `collage` | text span-5; a lit frame span-6 start-7 with the product window cut by its bottom, one result card that loops | the window alone | one card loop (tech) |
| `word` | an oversized h1 (144px, two lines) with one live word last, underlined; lead and buttons span-6, four facts span-5 start-8 | 54px on three lines | the live word, two rounds then rest (tech only) |
| `film` | a cinema frame on the lines holding the poster, h1 white on a calm part, the play disc at its foot | the frame, then the words | plays on a click |
| `statement` | one calm sentence (56px, two lines) over the page ground (tech: a dark ground on a dark page), lead, buttons, four facts | 34px on three lines | none |
| `triptych` | h1 52 on span-3, a collage of three to five pieces on span-6 start-4 whose sets change every 2.8 s, one large button ending on the right line | collage 342 wide, button full width | set change (tech only; still elsewhere) |
| `centred` | pill, centred h1 72 with the mark inline, lead, two pill buttons, then a lit frame across the wrap holding the product window, fading over its last 18% | the window less its list column | the window's story (tech) |

### The place hero

Every place page, never dealt: one still, full-bleed photograph of the place under the header with
nothing on it (no text, scrim, gradient, fade or box), the words on the ground below. It enters
once on load like every hero (`motion.md`, The hero's entrance); no moment in the hero itself.

- A shop or bookshop may take a letterbox inside the column instead: 1200 x 504, 24px under the
  header (`--photo: 528px`).
- The photograph is real and of this place in daylight: the room from the door, the counter with
  the machine, bread on shelves, the shopfront with customers, the workshop stand, an arrangement in
  a real room, the best room or the house. Never a mood shot, scenery, a cut-out or a hazy file; a
  florist never opens without flowers. The visit block is screen two, never inside the first.

## 4. Equal edges and the grid

- **One `.wrap`** for the header, every section and the footer: `width: min(100% - 2 * var(--gut),
  1280px)`. Lines at x 80 and 1360 at 1440 (a place: 1200 at x 120 to 1320), x 24 and 366 at 390.
  The same all the way down.
- **12 columns, 24px gutter** (12 on a phone). Column starts at 1440: 80, 189, 297, 406, 515, 623,
  732, 841, 949, 1058, 1167, 1275; spans 3 = 302, 4 = 410, 5 = 519, 6 = 628, 7 = 737. On a place
  (1200): starts 120, 222, 324, 426, 528, 630, 732, 834, 936, 1038, 1140, 1242; spans 282, 384, 486,
  588, 690. On a phone one 342 column or two 165 tiles 12 apart; nothing narrower than 165.
- **Every block starts on the left line or a column start,** and every block that ends on the right
  ends on a column end, the last on the right line. Anything wider than half the `.wrap` runs the
  full `.wrap`. Card rows (6+6, 4+4+4, 3+3+3+3): the first card on the left line, the last on the
  right, all one height, every row full. Text inside a card or visual is not a page line.
- **Two text lines:** the left line and the page's split line (the right column's start: k = 5, 6
  or 7, x 623, 732 or 841; a place always 6/6 at 732). Pick the split pair before building and use
  it on every split, the hero split, FAQ and visit included. Centred text moves left: the h1,
  section heads, the close and pricing heads all start on the left line (the `centred` hero is the
  one exception, on the page axis). No centred or right-aligned block wider than half the `.wrap`.
- **Splits:** text left, the visual right, top-aligned, on every split of the page: never mirrored,
  never alternating. The h2 and its intro sit on the left line above the grid. A filled column is a
  card and may pad its text 48px; text never sits inset in a bare column. Phone: text, then the
  visual, both 342.
- **Pictures:** a photograph spans 0 to the viewport as a layer, or starts and ends on the column
  lines (628, 410, 302 wide; place 588, 384, 282), one ratio per row (4:5, 4:3, 3:2 or 1:1; a place
  4:5, 4:3, 1:1). No photograph taller than 708px outside the hero.
- **Nothing** crosses a section edge, is cut off (no sliced heading, no ellipsis), staggered or
  peeking out behind another, and there is no dead space beside a short text.
- **1024 to 1279:** span-4 cards with a panel go two-up. **640 to 1023** (checked at 820 and 768):
  splits stack text first, panel cards take the full row, no row half empty. Nothing scrolls
  sideways at any width; no swipe rows.

## 5. Type

- One family, or a display face plus a text face with fixed jobs; never three; at most four font
  files. Never Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Space Grotesk, Plus Jakarta Sans
  or the system look.
- Display text of 40px or more outside a grid item counts as a heading; a statement set at h2 size
  is a fault. A footer wordmark may be larger.
