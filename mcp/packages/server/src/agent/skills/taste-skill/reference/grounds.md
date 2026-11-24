# Backgrounds

## The three tokens (every kind)

- **`--g-alt`:** the same hue (within 20 degrees), 0.06 to 0.15 darker, never under 0.70
  (`#ffffff` to `#f2f2ef`, `#f7f3ec` to `#ede6da`). Panels, tiles, cards and at most one full band.
- **`--g-dark`:** lightness 0.05 or less: near-black (`#111` to `#1a1a1a`) or the deepest shade of
  the brand hue, never charcoal, never violet. One dark body section at most (one screen tall), at
  the page's middle or later, never right under the hero; the footer may be dark. A dark page (main
  ground 0.02 or darker) and a dark hero are for tech only.
- **The brand band** (`.ground-brand`, product and place): one section in the brand's own colour
  (from the product or the shopfront) may replace the dark band, once, in the second half. Otherwise
  saturated colour lives in the accent and the pictures; one mid-tone section at most, never as the
  main ground.
- Grounds change in big blocks at the section edge: never on `.wrap` or a wrapper, no border-top or
  rule between sections, no band inside a section (a box of 80% of its width or more with its own
  ground holding the heading), no inset coloured box standing in for a ground. A frame holding a
  visual is fine.

## Other kinds stay flat

Product, service and place (site-kind other): every ground and panel is a flat CSS colour and
photographs are shown as they are. No gradient (a hard-stop two-tone included), grain, paper,
halo, texture, pattern, glass, contour, canvas, `backdrop-filter`, gradient mask, or shadow or tint
on the interface. A product page with site-kind tech is dealt as tech.
