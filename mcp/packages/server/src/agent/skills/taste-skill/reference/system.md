# System

## Base

- Spacing scale 4, 8, 12, 16, 24, 32, 48, 64, 96, 128 (`--s-1` to `--s-10`) for every margin, gap
  and padding you write. Heading to content 48px (32 on a phone); cards 24px apart (12).
- One height per card row and per tile kind, page-wide; sections at H or 2H.

## Type

- Headline and text weights: `layout-v4.md` section 5 (the one place they are set); tight tracking.
- Text people read (sub-lines, card lines, list items, answers) is 16px or more, line height 1.5 to
  1.8, in `--ink` at 7:1 or more. Large text (24px+) in a muted half or an inactive row 3:1 at least. On a place
  every text is 4.5:1 or more, and every word on the brand band 7:1. Never 14px paragraphs or 15px grey card text.
- The hero has one quieter level of small text at most (a grey fact line, or a pill above the h1).
- Highlight by contrast, never by colour: no marker highlights or coloured bars behind words; colour
  inside a word once a page at most, never on a place.
- Sentence case everywhere; labels 13px at 500, never tracked capitals or small caps; italic only
  for quotes, attributions and contact lines. Curly quotes; a number never breaks from its unit
  (never "250 / W"); lines at most 62 characters (`.measure`). Nothing under 13px: notes, the legal
  line, dropdown heads, image text.
- One size per kind of element across the page (every card title, address, figure). A figure never
  outgrows the h2 or the h1, at 390 too. Every word is live text, never baked into a picture; text
  never shrinks to fit.

## Colour

- **The interface stays 90 to 95% neutral;** colour comes from the photographs, the product, the
  work and real logos. One near-black ink, often warm, never #000, for text, hairlines (12 to 15% of
  it), button borders, interface glyphs and a designed mark.
- **One accent at most,** from the client (its product, shopfront paint, tiles, a bag label): the
  primary button (the only filled accent), the focus ring, links, state in visuals, small marks and
  the one brand band; under 3% of a screen elsewhere; its label 4.5:1 on it and it 3:1 on the
  ground. `--action` drives buttons, links and focus.
- **Grounds:** three tokens (`--g-main`, `--g-alt`, `--g-dark`), a brand band on product and place,
  and the tech CSS grounds: `backgrounds.md`. Dark pages and dark heroes are for tech only.
- **The grade** (light or evening) is chosen once on load or by a click, never by scrolling; the dark
  evening grade is tech only.
- **Words on a photograph** only in the hero and one closing band, on tech, product and service, on
  a crop whose calm part is dark and empty at the phone crop too, or on a solid box; no scrim or
  gradient over a photograph; never on a place.
- **Never violet or lavender:** a token whose OKLCH hue falls between about 270 and 330 degrees is
  turned to 255 (blue) or 345 (rose), whichever is nearer; a deal that returns violet is dealt again.

## Radius and buttons

- The primary carries the drawn arrow `svg.m-arrow` as its last child where the look shows one; one
  arrow style a page, only on the actions that need one.

## Nav

- `header.nav`: `position: fixed`, full width, `--nav` tall, opaque ground, a 1px hairline under it
  from the first paint, `z-index: 10`, the same at every scroll depth: no blur, transparency,
  shrink, hide, shadow, colour flip or floating pill, and nothing else on the page is sticky. Its
  `.wrap` is the page's: the logo on the left line, the main button ending on the right one.
- Four to six plain one-word nouns (ST-09; a place: Menu, Rooms, Workshop, Visit, About) at
  15px/500 that never wrap, each with its own anchor; a second action as a plain word only when the client has one
  (Sign in for an app with accounts, Gift cards for a shop that sells them); the main action as the
  one button. One word opens a full-width flat panel on hover after 150ms (link columns and a
  picture card, or picture cards; a place: its photographs with the name and the price from); a click
  on the word goes to its section. On other the panel has no shadow, only its ground and a 1px line.
- 640 to 1023: the bar keeps the primary button beside the 44x44 menu button, never a bar of only
  the logo and the menu. The menu button takes the secondary button's look.
- Under 640: the menu opens a full-screen sheet (56px rows, closes on any tap; a place adds the
  street and the week's hours at its foot). `nav.actionbar` (required on a place, optional
  elsewhere) is fixed at the foot, on the ground with a 1px top hairline: one 342x48 main action or
  two 165x48 buttons; `--bar` is then its height. It never covers a label or link. Hidden, it is off the screen and inert, so nothing in it takes the focus;
  it never hides while the focus is in it. The hero does not pad for it then.

## Footer

`footer.closing` is the page's last section (`layout-v4.md`): row 1 the dealt close, row 2 the
directory on one ground (link columns, the legal row). Types: `footer-columns`, `footer--dark` (the
name large, columns right; on a dark page a step darker), `footer--statement` (the lit ground; tech),
`footer--visit` (the address set large with the way there and the hours beside it). `.socials` stays empty
unless the brief gives the accounts.

## Cards, lists and forms

- `.card` as `cards.md` builds it; one height per row; never text in a box in a box. Open tiles
  (`.tile`) for rooms, models and people; `.rows` for menus, prices and specs (a 1px rule closing
  each row); FAQs open in full (`.faq`, no accordion).
- Forms: the recipe below.

## Forms

- **Size:** fields 48px with labels at 14px and 16px text (on the phone too, so the browser never
  enlarges the page), tap targets 44px, six fields at most, one column under 640.
- **Errors under their fields:** checked on submit, never while typing.
- **The button names the action:** the button is the main action word for word ("Request a
  table"), the sent line names what was sent in the button's own words ("Your table request is in.
  We reply within a day."), and a line under the form says when the reply comes.

## Access

- **Headings step down one level at a time** in `main` (h1, h2, h3); a footer's column heads are
  `h3` [heading-order].
- **Tab order is the reading order:** no `tabindex` above 0 [tabindex].
- **Focus shows at once:** the kit's ring (`:focus-visible`, 2px in `--action`, 3:1 on the
  ground) never animates; a page that removes it puts a change of the same strength in its place.
  A focused control is never hidden under the fixed header [focus-visible, focus-hidden].
