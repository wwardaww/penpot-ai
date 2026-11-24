## Look and layout

First decide what it is (software, game, product, service, or a place people visit), who uses it
and its one main action. It must look made for this client: if another client's logo would fit it
unchanged, change the composition or the picture.

- **Edges:** one column grid, the same left and right edge all the way down; every row full and of
  one height. Nothing tilted, staggered, floating or cut by accident.
- **Space:** one scale (4, 8, 12, 16, 24, 32, 48, 64, 96, 128); more space between groups than
  inside them; heading to content 48 (32 on a phone).
- **Hierarchy:** one dominant element per view. Size and space make it, not weight plus colour. Each
  text level at least 1.3x the next (1.2x on a phone). Headlines 400 to 500 with tight tracking,
  text 400 and 500, running text 16 or more at line height 1.5 or more, nothing under 13, lines up
  to 62 characters, sentence case. No label over every heading.
- **Fonts:** one family, or a display and a text face. With no font given, skip the defaults
  (Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Space Grotesk, Plus Jakarta Sans), even
  where a task section names them as examples; pick for the client among faces that carry its
  letters (Turkish: Figtree, Instrument Sans, Hanken Grotesk, Schibsted Grotesk, Onest, Bricolage
  Grotesque, Newsreader, Fraunces, Literata).
- **Colour:** the interface 90 to 95% neutral, ink near-black and never #000, one accent from the
  client for the primary button, links, focus and state. With no brand colour, never violet,
  lavender or a blue-purple gradient. Read text 7:1, the rest 4.5:1.
- **One system:** one filled button per view and one secondary style, one radius family, one card
  style. Two boxes deep at most; no card inside a card.
- **No decoration in place of content:** gradient blobs, glass, glow, floating cards, emoji as
  icons, coloured side bars, strips of big numbers, rows of three icon cards, a shadow on all.
- **Pictures:** the real subject (the user's images, the real interface at true size). With none, a
  flat frame at its final ratio, named after the exact picture it needs; one ratio per row. Never a
  drawn stand-in, a redrawn logo or a caption under a picture.
{{#web}}
- **Web pages and sites:** the hero fills the first screen alone (about 900 high at 1440, 844 at
  390): an h1 of 2 to 8 words that names the thing and for whom or where, one line, at most two
  buttons, and the subject itself. Never a slogan centred over two pills and a floating dashboard.
  Then one idea, one heading and one picture per section, each about one or two screens, short ones
  merged; neighbours never share a layout, a card layout at most twice; no section without a
  picture except prices, questions, specs and forms. Change grounds in full-width blocks. Software
  shows its own interface big once; a product is big and pictured anew each time; a game is named
  and led by key art; a place or service leads with photographs, flat grounds, address, hours and
  prices. Dark pages only for tech and games. Nav: four to six one-word nouns and one button. The
  main action has the same words everywhere.
- **App screens** (dashboard, list, form, settings): no hero or section rules. The task and its
  data first, dense where people work; a table or list before cards; no marketing headings, no row
  of figures unless it drives a decision. Draw empty, loading and error states when asked for or
  when the screen cannot be read without them.
{{/web}}
{{#mobile}}
- **Mobile screens:** hero and section rules do not apply. One job per screen, the main action in
  thumb reach, targets 44 or more, lists before cards, platform navigation, side margins of 16 to
  24 kept on every screen.
{{/mobile}}
{{#game}}
- **Game UI:** website rules (hero, sections, neutral share, no dark pages, sentence case, plain
  frames) do not apply; the game's world sets face, ornament and colour. Keep hierarchy, one
  system, edges and contrast over moving scenes. Text 24 or more at 1920×1080, content inside a 5%
  safe area, a clear focus state for gamepads, the HUD at the edges.
{{/game}}

Not for this canvas: upstream's scripts, checkers, asset kit, dealt layouts, HTML attributes,
shaders and scroll scenes. Motion follows the project's animation rules. Look at a screenshot
before you finish and fix what breaks a rule above.
