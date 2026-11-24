# Sections

## 1. Plan in screens

- **Every section shows the real thing:** a photograph, a portrait, real icons, the client's UI, a
  diagram card or (tech only) the effect. A section without a picture is allowed only for a price
  list, an FAQ, a specs table, a booking form or a dealt statement moment's own section, once each,
  and two picture-less sections are never neighbours (the short page with no photograph, its
  statement hero, its statement moment and its one section, is the one exception, section 4). A quote needs a face or merges into the section above. The picture takes a real share:
  half a tile or more, 50/50 in a split, a whole screen as a layer. The close is its own picture (a
  photograph, the big button or the name set wide).
- **One object never carries the page** (in testing: a robot arm in six sections and a game's
  salvage rig in six, each "one object six times", both capped at 4 to 4.5). The object shown whole
  (the product's photograph, a game's key art) leads the hero and **at most two
  more sections**; every other picture section is carried by another kind of visual the brief
  supports, from its row below, no kind more than twice. A new angle, a recolour or a crop of the
  whole is the object again; a use photograph counts as use only when its setting fills the frame
  (the bench, the street, the room, half the picture or more; the object one thing in it). Write
  each plan line's kind; three object lines at most.

  | Kind | the object whole: hero + 2 | carries the other sections |
  |---|---|---|
  | Software | the `app-frame` | UI fragments of its subject on cards, a diagram card, real tool icons, a type moment, a named quote with its face, the effect or scene |
  | Gaming | the client's key art (none: the setting's photograph under the game's name) | the world (in-engine shots, else photographs of its setting), the crew at work (the client's screenshots), the trailer frame, the screenshot strip, a type moment, the real platform marks |
  | Tech hardware | the product (photograph, the client's CAD render; a render only when the brief asks for 3D) | its use (the device at a bench or in its place), parts close up, the motion video frame, a diagram card held still, a type moment (one figure set large), a context photograph of the trade (a workshop, a lab) |
  | Product | the product (photograph; a render only when the brief asks for 3D) | its use (loaded, carried, at home), people with it, close-ups of its parts, a diagram card held still, a type moment, a context photograph of where it lives |

- **The client's own assets get designed slots.** When the brief says the client has a trailer,
  key art, in-engine screenshots, CAD renders, an exploded model or a motion video, each gets a slot
  that reads finished now: the frame at the file's final ratio, holding a stand-in photograph (a
  kept live-search frame of the game's setting or of the product's kind in use, `photos.md`; a kit
  render still only when the brief asks for 3D), named in a comment for the client's file, never an
  empty, grey or broken frame and never a line saying the file is missing. The report lists every slot, its file and its stand-in.
- **One idea per section,** one h2, one action at most besides the main one (a pair only in the
  hero, or where a product needs "compare" beside "buy"). A two-screen section holds one list, table
  or form, or one idea in two groups, never two ideas.
- **The main action** reads the same, word for word, in the nav, the hero, the close (or the
  booking) and the phone bar, and nowhere else as a filled button (a place whose action is Get
  directions keeps it out of the nav, section 4).
- **Merge short blocks:** a quote, logo row, stat row or FAQ that alone would hold under 495px (464
  at 390) goes into the section above as its last element, 64 to 96px under its content, with no
  heading or ground of its own. An FAQ that reaches 495px with its answers open is its own section.
- **Repeats:** a card layout (2x2, bento, three cards, split card, open tiles) at most twice a page;
  neighbours never share a layout; on software, product and service a calmer section (quote, prices,
  FAQ) after at most two visual ones, and the back third of the page calm before the close. Repeat
  the section scaffold (head, padding, ground logic) so it is learned once.
- **Proof as small exact objects,** only from the brief: a named quote with a face, a footnoted
  figure, press lines, a rating line, real customer logos with permission. No row of big stat
  numbers, no filler stat strips, no check-icon lists, no customer-logo wall.
- **Two boxes deep at most:** a card and its picture panel, or a panel and its UI. A card whose
  panel holds UI drops its box (`.card--open`) or runs the panel flush (`.panel--flush`).
- **One page, real links:** every nav word, button and footer link goes to an `#id` on the page, the
  logo to `#top`. The main action goes where it is done: the booking form's or the order section's
  id, `#visit` (the visit block) for Get directions, or, when the page has no form or booking system,
  a `mailto:` on `.example` (`copy.md`). Privacy, Terms and
  Imprint go to small pages you write (Imprint only when the brief gives the company's own details),
  or are left out. Never `/contact`, `/[page]` or a bare `#`.
- **At 390** the page keeps the desktop's grounds, photographs and order, each photograph after
  its text.
- **At 768 and 820** (the judges' tablet, held upright) plan the screens again: each section's
  stacked content within its screens (832px a screen at 768x1024), else two screens there or less
  that stacks; the first screen ends on a whole picture or a clear bleed (`layout-v4.md` sections 2
  and 3). Write the tablet count on the plan line when it differs ("2 at 768").

## 3. The plans

Optional parts in brackets; each list is the order on the page. Tell it as a story: say what it
does, show it, prove it, let people explore. Tabs only on software, click only.

**Software** (and AI, developer tools, fintech). nav, hero, [logo-row docked in the hero],
**app-frame** (the product big: its list beside the open item in one app window across the
`.wrap`, as section 2 or 3; `sections-library.md`), two or three feature sections in different layouts (features-2x2, bento, split-text-left,
tabs-tour, chapter, steps), [integrations as a `fanin-warehouse` or `hub-tools` diagram card;
integrations-grid only for 9 or more tools the brief lists],
[quote-stat (a quote the brief gives) or customer-proof-row (customers the brief names); with
neither, the calm section is pricing or the FAQ], [pricing-three, pricing-two or
comparison-table], faq, footer.closing. The effect, moments and scene as `effects-usage.md` deals them. Nav `nav-mega|nav-cards|nav-centre` · footer `footer-dark|footer-statement|footer-columns` · close
`close-type|close-word` · rhythm `dark-band|surface-pairs|space` · buttons `solid|pill|tonal|arrow`. Never: stock people at screens; an object render in place of the product; a page whose product
shows only as small fragments centred on coloured panels (in testing: about 3.5 points under Linear).

**Gaming** (a game, a studio launching its game; page type software, site-kind gaming). nav, hero
(the game, named), [the trailer frame], the world (one or two sections, full bleed), what you do
(the screenshot strip as three to five open cards, one verb each, sail, salvage, rebuild, each
with its capture), [a system of
the game as a diagram card: matchmaking, saves, stores], platforms and editions (the real store and
platform icons, prices from), [press lines or a quote the brief gives], [faq], footer.closing with
the main action (Add to Steam wishlist, Pre-order). In testing, a game page that never named the game
and showed an abstract effect for key art lost 3.5 to 5.5 to one with a launch date, a scene of the
game's world, feature cards and real platform icons. So:
- **The hero names the game:** the h1 is its name and genre ("Northline, a co-op survival game",
  40 characters at most on the `product` stage, 32 on the `photo` hero), or its wordmark (the client's logo file) over an
  h1 naming the genre. The lead or a line under it carries the launch date or status the brief
  gives ("Out 12 March on Steam", "Early access now"); with no date, the status ("Coming to PC"),
  never an invented date.
- **Key art in the hero and the world sections, full bleed:** the client's trailer (a film hero),
  key art and in-engine shots, one grade, as layers or on the column lines.
- **The world and the crew carry the page, not the hero object** (section 1, One object): the
  hero object whole in the hero and two more sections at most; the world, the crew at their jobs,
  the trailer frame and the screenshot strip carry the rest. Art the brief names gets its slot
  either way (section 1, client slots): a trailer frame, the screenshot strip, key art on the
  stage.
- **No art files** (the brief names art it does not supply, or none): the hero is **type-led over
  a photograph of the game's setting**, never an effect or a random object in its place. The world
  section takes the widest of the frames full bleed in a `media-band` or `dark-band`, the h2 above
  it; the trailer frame's poster and the screenshot strip are client slots holding the other
  frames (section 1, client slots), each named in a comment for the client's file. Every frame
  is a stand-in: the report lists each one and the art to replace it. A rendered hero object or
  world (`effects-objects.md`, Product renders) only when the brief asks for 3D or a render.

**Product.** nav, hero, the range or line-up within the first three sections, two or three feature
sections (one benefit each, each its own composition, below), specs (`rows--spec` or
comparison-table), proof (a review or press line the brief gives), [visit-map for a showroom],
[faq, five questions at most], footer.closing with the newsletter. Every main section shows the
product's world, two or three photographs a screen (one per feature section of the part it names;
a grid of 4 to 8 cut-outs on one backdrop): the product whole in three at most (section 1, One
object), its use, its parts and the people with it in the rest. Prices are "from" prices on cards or in a table, never a plan
table or a monthly switch; only prices the brief gives (none given: "Price on request" or no price, `copy.md`, What may
be assumed). Photographs first: the client's, else stand-ins (below). A technical
product (site-kind tech) may take the effect; any other product takes no effect; a render on
either only when the brief asks for 3D or a render (below).
- **The product is the hero, not every frame.** The bar is Figure and 1X: where the product is
  shown whole it fills the frame at large scale, and its use, parts and place carry the rest. In testing, a rendered product page scored 5.5,
  creativity 4.5 ("a safe grey template"), because every visual was a mid-size product in a grey
  rounded panel on a grey ground, five pictures in three poses, one structure three times. With
  photographs or with the render alike:
  1. **Big.** In the hero and at least one more section the product fills most of its frame (its
     long side 80 to 100% of the frame's width, or cropped so it runs off an edge) or stands on the
     section's own ground at anchor scale (8 or more of the 12 columns at 1440, the full column at
     390).
  2. **The whole product in three sections at most, a different picture in every section.** The
     product whole (any angle, any colour) in the hero and two more; the rest carried by its use
     (loaded, at the bench, at home: the setting fills the frame), close-ups of its parts, an
     exploded view, people with it, a diagram card held still or a type moment (section 1, One
     object). Never one view twice: a smaller file (`-700`), a recolour or a mirror of a view is
     the same view. Each plan line names its section's picture and its kind; no two alike.
  3. **Every promise in a headline is shown in a picture.** A family bike shows the child bench
     with its belts; a lamp shows the light it throws on the table; "takes four crates" shows four
     crates, readable at the section's size. A promise with no picture: add the picture or cut
     the promise.
  4. **Dealt compositions, one contrasting ground.** For the product: `bleed` the product at anchor scale across the
     viewport; `pair` two views at one ratio; `trio` the whole, a part, a detail; `strip` four
     close-ups of the parts the rows name; `tall-small` the product in use tall, a detail small. One section stands on a contrasting ground (the rhythm below, `dark-band` or `brand-band`)
     and holds the strongest view; the rest share one flat ground. Frames take the page radius,
     never a panel inside a panel.
  5. **The colour choice changes the picture.** A colour offered and never shown is a fault.
  6. **No fact twice.** A stat strip never repeats the spec rows below it: the strip takes the
     three figures that sell (load, range, price), the rows the rest (sizes, weight, motor,
     battery, warranty). One fact, one place, one wording.
  7. **Buttons step on hover and press on click.** The motion layer does it (`motion.md`,
     Button); no page CSS sets a `.btn`'s `transform` or `transition`. A feature card that leads
     somewhere is a linked card (it lifts 2px, its picture zooms 1.03).
- **No photographs: the product is shown, never hidden, in photographs** (in testing: a cargo
  bike's page that never showed the bike scored 3 of 10, and pages carried by renders and their
  props read as random 3D objects). A picture the brief gives (a cut-out, a CAD view, its own
  render) goes on the hero's stage. Keep a
  frame only when it shows the same kind of thing whole or in use (a cargo bike for a cargo bike,
  never a wheel for a bicycle), with no maker's name, logo or badge readable (crop it out or drop
  the frame), no face passed off as a customer, and one light and grade across the set. The page is the
  **full product page**, never the short page: the plan gives each section one picture of its own
  kind (the product whole, its use, parts close up, people with it, where it lives), the product
  whole in three sections at most (rule 2), the hero first and the order card last, no other fixed
  order. A colour the stand-ins cannot show stays a named swatch in the order card and goes on the
  report's shot list (rule 5 waits for the client's photographs). Every frame is a stand-in: the
  report lists each one with the photograph to shoot in its place (`photos.md`); nothing on the page
  says so. Never a `split` hero holding only an order form or the effect in place of the
  product; the order card is its own section, last.

**Service** (clinics, firms, agencies, studios, trades). nav, hero, services-list (each with one line
and a price from when the brief gives one; a peek-list when each service has its own photograph), work (a grid of 3 to 6
project photographs, or photo-pair, one per case), steps, people-row, proof (a quote the brief
gives), [pricing-two or a `rows` price list], [faq], booking-form with the address, footer.closing.
Pictures: photographs of the work, the team at work and the rooms, one or two a screen; real icons
for tools a studio really uses.
Nav `nav-mega|nav-split|nav-centre` · footer `footer-visit|footer-dark|footer-columns` · close
`close-type|close-photo` · rhythm `surface-pairs|dark-band|space` · buttons `solid|tonal|block|arrow`.
Never: product UI the firm does not run; stock handshakes; logos of invented clients; tabs.

## 4. Place

Cafes, bars, bakeries, restaurants, guesthouses and small hotels, shops, bookshops, florists, bike
shops, local studios (pottery, yoga; a creative agency stays service; a maker people visit who
also teaches or sells online stays a place: the door decides, the web shop is its goods section). Real still
photographs, type and flat colour carry the page; the interface around them is one ground, one ink,
hairlines and one button style. Where a recipe and this section differ on a place, this section
wins. Open these references first for the feel (never copy one): Daunt Books, Prufrock, Bourke
Street Bakery, Gail's, Tartine, Bonanza (a still where Bonanza has film).

### Plan and length

The nav is not a screen; `footer.closing` is one; a 2-screen section counts two.

- **Full page,** 12 to 20 photographs, 2 to 3 a screen, at most 6 screens: hero, visit, the offer
  (a second offer may follow: a roaster's beans after the menu), the place, then orders or booking
  when taken (last before the footer, its cards or form in place of the close), footer.closing.
  Over 6 screens drop the place, never the booking.
- **Compact page,** 8 to 12 photographs, 4 or 5 screens: hero, visit, the offer, [the place],
  footer.closing.

These three names mean only these lengths everywhere in the skill.
- **Photographs by section,** all distinct: hero 1; visit 1 (0 with a map); menu or prices 1; rooms
  2 to 6; goods 4; the place 3 (row), 1 (story) or a wall; orders 2 or 3, or booking 1; close 1. Nav
  panel photographs do not count.

### Designed variety without effects

A place earns its creativity from photographs, their arrangement and one moment of type, never
from an effect (in testing: correct cafe and guesthouse pages scored creativity 2.5 to 4 and motion 3
to 4.5 because every section was text beside one picture and nothing answered the pointer).

- **Never two sections built round one picture.** The visit keeps its 6/6 split with one
  photograph; every other photographed section takes a composition, the offer and the place each a
  different one, neighbours never the same. Text beside a single photograph happens once a page
  besides the visit (`story`, or the booking form).
- **The five compositions** (1200 column, gap 24; grid widths span-3 282, span-4 384, span-5 486,
  span-6 588; square corners, one grade, no words on any photograph):

  | id | at 1440 | at 390 |
  |---|---|---|
  | `bleed` | the head row on the `.wrap` (its line at the right), then one photograph across the whole viewport, 1440x560, nothing on it; once a page, never right after the hero | 390x488 (4:5 crop) |
  | `pair` | two photographs on span-6, the same ratio (4:3 at 588x441 or 4:5 at 588x735 in a 2-screen section), tops level; the head row above | stacked, 342 wide, 24 apart |
  | `trio` | the offset trio: three photographs on span-5 (4:5, 486x607), span-4 (1:1, 384x384) and span-3 (4:3, 282x212), tops on one line, three sizes of one subject family (the room, its table, a cup) | the first 342 wide, the other two two-up at 165 |
  | `strip` | the detail strip: four 1:1 details on span-3 (282x282) or six on span-2 (180x180) from line to line, hands, tools and materials of one trade, under the section's text or groups | two-up at 165, four at most |
  | `tall-small` | a tall 4:5 photograph on span-6 (588x735) at the left line; on span-5 at the right the h2, its lines and link at the top and a 1:1 on span-3 (282x282) at the bottom, its foot level with the tall one's | text, the tall one at 342, the small one at 165 |

- **Hover you can see:** every photograph that leads somewhere is a link (a room to its booking, a
  goods photograph to its card, the place to its story) and zooms 1.03 inside its frame while its
  card lifts 2px; the head row's link carries the arrow; the nav words draw their underline
  (`motion.md`). Each section after the hero holds at least one such link.
- **One main action a screen:** a transaction (Book a room, Order a cake) is the nav's button and
  the hero's, as on any page, and nowhere else but the booking or close and the phone bar. Get
  directions is never repeated: the hero's one button and the phone bar's (and the nav's button on a desktop: two on a
  screen at most, `action-repeat`); the nav says "Visit"
  as a word to `#visit`, the visit block adds no second button for it, and the footer gives the
  address linked to the map, never a button (in testing: Get directions in the bar, the hero and the
  footer read as clutter).
- **List text at 16px:** menu rows, descriptions, room facts and hours at 16/24 at least (the muted
  colour, never a smaller size, marks a description); 13px only for a group label.
- **Credits:** the one footer line that links the credits list (`photos.md`, Credits), never one
  link per photograph in the footer.

### The sections (1200 column, x 120 to 1320)

- **Hero:** the place hero (`layout-v4.md` section 3). What, where and one fact: h1 "Bakery on Mill
  Street, Leith" (40 characters at most); sub-line "Sourdough, rye and cardamom buns from 7:30,
  Tuesday to Sunday." (80 at most); one button, the main action.
- **Map** only when the brief gives the street: `fx-map` baked still (`effects-creative.md`) in the
  photograph's frame, the pin on the street line; never an embed, a contour or a dot pattern.
- **The offer** opens with a head row: the h2 on the left line, one line, 40 characters at most
  (32/40; 24/30 at 390); at its right, on its baseline, one 16px line and a link ("Full menu", "See
  all"); 56px to the content.
  - **Rooms:** h2 "Rooms and prices", the side line "Breakfast 8 to 10. Check-in from 15, check-out
    by 11." Each room: a 4:3 photograph of the whole room, straight-on, window light; 20px; the name
    (`h3.t-card`, 20/28); the facts at 16/24 muted ("2 guests · 18 m² · garden side"); the price
    from with its season at 16/24; a "Book this room" link. `row`: three rooms on span-4 (384x288)
    or four on span-3 (282x212); two rooms always `side`. `side`: the head as the first cell at the
    left line, top-aligned with the tiles (two rooms span-4; three span-3; four: rooms 2x2 on span-4,
    `--h: 2`). Five or six rooms: rows of three on span-4 in a two-screen section. At 390 one column,
    342x256, 48px apart.
  - **Goods** (beans, bread, books, parts, bouquets): four linked cards on span-3, 1:1 at 282x282
    (bouquets 4:5 at 282x352), one ratio per grid, one backdrop, angle and light. Each card a flat
    fill one step off the ground or a 1px hairline, no shadow, radius or pill; inside its padding
    under the photograph only the name (a two-line slot, 16/500) and the price; an outline Add
    button aligned across the row where it sells online. One or two full rows. At 390 two-up at 165,
    four or six, then a full-width button to the range; no swipe row.
- **Orders** (cakes, a bike service, weddings, classes): three kinds on span-4 under the head row,
  or two beside the head in the first span-4. Each: a 4:3 photograph of this business's own goods
  (384x288), a 1px hairline, a 13px label, the title at 20/28, one or two sentences at 16/26 with the
  lead time, where to collect and the price from, one text link with an arrow. A florist's events
  kind says what to send: date, venue, guests, budget.
- **Booking** (rooms, or classes with dates): the head row ("Book a room"; "We reply within a
  day."), then a 4:3 photograph on span-6 (588x441) and beside it the form on `--g-alt`, the same
  height, 48px padding: arrival and departure on one row, guests and name on the next, email, the
  main action, the reply line at 14px. Never
  a photograph, texture or glass under the form. A booking system the brief names replaces the form.
- **Close:** `close-photo`: the h2 (eight words at most), one line ("Open today 7:30 to 16:00"), the
  main action, a 1:1 photograph never used above and never with words on it. On `colour-band` it
  sits on `.ground-brand`, every word at 7:1 (`backgrounds.md`), the button inverted.
- **Footer:** `footer-visit` (the address at 32/40 on span-7, linked to the map search, with one
  line on the way there and no button, the hours from the split line with today marked, the nav
  row, the legal row with the one credits line; then the name set wide across the `.wrap` in the
  display face at 400, at most `12vw`, except on `colour-band` or with the `name` moment) or
  `footer-columns` (Visit, Contact as given, the nav's words, delivery or check-in or the
  newsletter; the legal row).
- **Notice line** (a florist's delivery cut-off, changed or holiday hours): one still 14px line with
  a number above the h1 (`layout-v4.md`), repeated where the fact belongs; never rotating.
- **Splits** 6/6, text left, top-aligned, never mirrored; on a phone the text first.

### Order by trade

Each starts hero, visit; the rest in this order, 4 to 6 screens:
- **Cafe:** menu as text with its composition; the place (its composition or a story row); beans
  or goods only if sold.
- **Bakery:** what it bakes (goods with prices); orders (one card per kind); the process (its
  composition, a `strip` or `trio`, one screen at most). Several shops: a ruled list, each with its street.
  Under 8 frames (the library deals a bakery 4) it is the short page (section 4, The short page).
- **Guesthouse or small hotel:** the hero is the landscape of its region when the brief names one
  (a remote house is sold by where it stands, as Fogo Island Inn is); location as the visit (how to
  arrive, the `address` moment fits); rooms; the house (shared spaces and breakfast in its
  composition, `bleed` for the land around it, no labels); booking. Check-in and check-out beside the rooms and in the footer.
- **Shop or bookshop:** new in (goods with Add); categories as a plain text list; one story row; the
  footer with each shop's address and hours and the newsletter. Nav: four to six category words (`system.md` Nav; four on nav-split).
- **Bike shop:** visit and workshop (usual repair turnaround); workshop prices as ruled rows with
  "Book a service"; new in (cut-outs on white, name and price); brands as a plain text list; story.
- **Florist:** a notice line with delivery area, cut-off and price; delivery and visit as screen 2;
  bouquets (four 4:5 tiles, each with a price from); weddings and events (three photographs of real
  installations, what to send); workshops as ruled rows.

### Look

- **Grounds:** the palette's ground and surface, one full surface band at most; one brand band
  (`backgrounds.md`); no dark section except that band (the nav bar may take the dark ink). Flat
  colour only (`backgrounds.md`).
- **Motion:** the hover layer only (`motion.md`), and it must show: the nav words and links draw
  their underline, a linked photograph zooms 1.03 inside its frame while its card lifts 2px,
  buttons step and press, arrows move 3px.

### The short page (under 8 photographs)

Under 8 usable, whatever the trade (the count in Plan and length): three screens, 2,700px at most at 1440 (the tablet
runs longer, below; four with no photograph, Its one moment below): hero, one `--h: 1` section holding the
visit and the offer, footer.closing. With one or two good photographs, the best is the hero's and
the other is the section's, in one row with the groups (With its photograph, below).
- **The section** is open type on the page ground, never a card or a ground box (across the `.wrap`
  that is a band): the offer as ruled text in groups (a maker's tableware and its classes are two
  groups of rows, prices visible), then the visit block as three `span-4` columns on the grid
  (address, hours with today marked, access; a phone only when the brief gives one). A maker's
  story is one 20/30 paragraph at the head of the visit block, never a section of its own.
- **Nav and the main action:** three or four words, one per group, each pointing at an `id` on that
  group (`#tableware`, `#classes`, `#visit`); the main action points at the group that does it
  (section 1, One page).
- **What the deal drops.** Write "not used" beside
  each skipped part on plan line 2.

No mood stock, code ground, drawing, empty box or note. The report lists the shots to take
(`photos.md`). At 8 good photographs it grows to the compact page, at 12 to the full page. A place
with no photographs of its own takes the draft path and a live search first (Plan and length); the
short page is for a place whose frames, counted as in Plan and length, total under 8.

## 5. Visuals

- **Diagram cards** (`diagrams.md`): when the point is how things connect; tech 0 to 2 with pulses,
  product and service one held still, place none.
- **Real icons** (`icons.md`): every tool, app or file type the page names, in its own colours; on
  other pages only tools the client really uses.
