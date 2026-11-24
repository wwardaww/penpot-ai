# Motion

## The rule: every page moves, in three places

Every page, every kind, has the same three layers of motion, and nothing else moves:

1. **The hero's entrance** on load, once (below): the h1 line by line, then its lead and buttons, the
   picture settling. About 1.1 s, then the hero stands.
3. **The hover and press layer** below, on every link, button, linked card and linked photograph,
   and the swaps a click or a tap makes (a tab on software, a peek-list's photograph).

**Scrolling moves nothing but the dealt moment.** A moment may hold its own section on screen with `position: sticky` while the page scrolls natively.

**Why it moves.** The plan names each motion and its purpose in a few words, one line each: "hero
entrance: the name arrives first, then what to do"; "photo-chapters in Rooms: three rooms shown in
the space of one"; "hover: every link answers". A motion with no purpose is cut.

## The hover layer

Hover moves only for a fine pointer (`(hover: hover) and (pointer: fine)`; keyboard focus shows the
same state anywhere); every hover control also works by tap and keyboard and has a focus state; nothing resizes or pushes a neighbour; no rotate, skew, glow, shine sweep or chip glide.

| Part | Motion | Time |
|---|---|---|
| Button | on hover the fill steps 14% toward the ink (an outline gains a faint fill and a stronger border) and the box steps up 1px (2px on `.btn--xl`); press sinks it to 1px below rest and scales .985, so a hover shot and a press shot each show a move; the text-link secondary of the `arrow` and `block` button looks keeps its underline and does not step (its press scales .985 only); fine pointer only; page CSS never sets a `.btn`'s `transform` or `transition` | 150ms in, 120ms out, 90ms press |
| Arrow | `svg.m-arrow` moves 3px right and settles back; one arrow style a page | 150 / 120ms |
| Link | one underline style at regular weight: running text and `.link` rest on a faint 1px hairline and an ink line draws left to right, leaving to the right; nav and footer words rest bare, darken and draw a 1px line 4px under the word | 150 / 120ms |
| Nav | the words take the drawn underline (no gliding pill on any kind); the panel opens after 150ms of intent, fades in with a 6px drop with its columns together (one surface, never column after column), closes in 120ms; with one open the next word swaps it at once; the chevron turns 180 degrees on tech, flips at once on other | 200ms, 120ms |
| Card with a link | lifts 2px, its border darkens a step, an optional soft shadow (blur 24px, 10% ink at most, only on hover) | 180ms in, 120ms out |
| Card without a link | nothing (`.m-nolift`) | |
| Photograph in a linked card or link | scales 1.02 to 1.03 inside its frame (`overflow: hidden`); the frame, card and boxes never grow; never dims, fades or takes an overlay; a product card's name underlines with it (`.m-zoom` for any other wrapper) | 600ms in, 400ms out |
| Focus | a 2px ring in the action colour, 2px off the control, drawn in full in the frame the focus lands; no transition | none |
| Field | the action border and a 3px soft ring | 140ms |
| `.m-switch`, `.m-check` (tech) | the knob slides 16px and stretches 4px while pressed, both by transform; the tick fades in as it grows from 70% to full size; on other they jump | 180, 90, 160ms |
| Copy button (tech) | the glyph swaps to a check in place, holds 1.5 to 2 s, returns | 150ms |

## Never

- A section heading that rises on every section, a second hero entrance, an entrance longer than
  about 1.1 s, or an entrance that hides text a visitor could already be reading.
- A card that tilts, flips, scales, follows the pointer or glows at the cursor; a magnetic button.
- A carousel, a slider that advances by itself, timed tabs, a rotating notice, a logo marquee.
- Blinking at random: twinkling dots, glitter, flicker, hue cycling, scrambled text; every change
  shows a state, a step or real data.
- A loop that plays once (outside a card story's replay), a card loop's cycle over 4 s, two loops in
  one panel.
- A hover slower than its token, an overshooting ease, a delay before a button reacts, a focus ring
  that animates, a second underline or indicator style, an animated width, height or margin.
