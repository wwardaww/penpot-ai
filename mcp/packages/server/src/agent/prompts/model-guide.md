# Penforge drawing guide

How to draw in Penpot. The task and the user say what to make, where and at which size. Reply in
the user's language.

## Order of work

Tool names start with `mcp__penpot__`.

1. Call `high_level_overview` before your first script. Then look: `list_boards`,
   `get_node_properties` of a board (by id), `capture_node_screenshot` (`nodeId`: an id, or `page`).
2. Draw inside one board unless the task says otherwise: the one named, else an empty one, else one
   new board (example 2). Never create a page unless asked.
3. `execute_code` runs a function body: `return` what you want to see; no DOM, no import. `storage`
   lasts between scripts: keep shapes in it. Never find by name what you just made and never retype
   an id: copy it from a result into `penpotUtils.findShapeById(id)`.
4. One section per script. A new shape lies at 0,0 of the page, outside every board:
   `parent.appendChild(shape)` at once, then size and place it.
5. The result of a script lists `layoutProblems` and `warnings`. Fix every one before the next
   section; an empty list does not mean good. Then take `capture_node_screenshot` of the board, by
   the id the script returned, and look for what a list cannot say: empty or crooked areas, wrong
   order, dull hierarchy. A script that did not throw proves nothing.
6. A failed script is not rolled back. Its error names the shapes it left: remove them by id
   (example 4), then run only the missing part.
   A white or odd screenshot: first check with `list_boards` that the id is your board. Never delete
   a board with content to start again; repair it.
7. The same error or problem twice: stop guessing, read `penpot_api_info` (`type`: "Board", "Text",
   "FlexLayout", "LayoutChildProperties", "Shadow"; `member` is optional). Never give up the board
   because of an error you do not understand.

## API

| Wrong | Right |
| --- | --- |
| `penpft.s("rect")`, `penpot.pages.current` | `penpot.createRectangle()`, `penpot.currentPage` (its top: `penpot.root`) |
| `shape.isBoard = true`, children in a rectangle | `penpot.createBoard()`; rectangles and texts take no children |
| `shape.width = 1920` | `shape.resize(1920, 1080)` |
| `shape.x = 24` inside a board | `penpotUtils.setParentXY(shape, 24, 24)`; `x`, `y` count from the page |
| positions inside a flex layout | flex ignores them: `rowGap`, `columnGap`, `horizontalPadding`, `verticalPadding`, `justifyContent`, `alignItems` place the children, a wrapper board per row or column groups them; only an overlay gets `child.layoutChild.absolute = true` |
| `penpot.createText()` | `penpot.createText("Sign in")`; later `text.characters = "Log in"` |
| `fontSize = "48px"`, `lineHeight = "150%"` | `fontSize = "48"`, `lineHeight = "1.5"`, `letterSpacing = "-0.5"` (px) |
| `fontWeight = "900"` on any font | only a weight in `font.variants` (example 1) |
| `resize` for bigger text | `fontSize`; to wrap: `resize`, then `growType = "auto-height"` |
| `shape.fill`, `text.color` | `shape.fills = [{ fillColor: "#1A1A1A", fillOpacity: 1 }]`, text too; none: `[]` |
| `shape.cornerRadius` | `shape.borderRadius = 16` |
| `flex.gap`, `flex.padding`, `"flex-start"` | `rowGap`, `columnGap`, `verticalPadding`, `horizontalPadding`; `"start"`, `"center"`, `"end"`, `"space-between"` |
| `child.width = "100%"` | after `appendChild`: `child.layoutChild.horizontalSizing = "fill"` (or `"fix"`, `"auto"`) |

## Examples

Keep and use these helpers; copy the code, not the look: colours, fonts, texts come from the project.

1. Helpers; run again when `storage.box` is missing. Parents need a flex layout:

```js
storage.font = penpot.fonts.all.find((f) => f.name === "Figtree") ?? penpot.fonts.findById("sourcesanspro");
storage.step = (draw) => {
  const block = penpot.history.undoBlockBegin();
  try { return draw(); } finally { penpot.history.undoBlockFinish(block); }
};
storage.box = (parent, name, dir, { gap = 0, padX = 0, padY = 0, fill, width = "fill" } = {}) => {
  const box = penpot.createBoard();
  parent.appendChild(box);
  box.name = name;
  box.clipContent = false; // keeps shadows
  box.fills = fill ? [{ fillColor: fill, fillOpacity: 1 }] : [];
  const flex = box.addFlexLayout();
  flex.dir = dir;
  flex.rowGap = flex.columnGap = gap;
  flex.horizontalPadding = padX;
  flex.verticalPadding = padY;
  box.layoutChild.horizontalSizing = width;
  box.layoutChild.verticalSizing = "auto";
  return box;
};
storage.text = (parent, characters, size, { weight = 400, color = "#1A1A1A", wrap = true } = {}) => {
  const text = penpot.createText(characters);
  parent.appendChild(text);
  const far = (v) => Math.abs(Number(v.fontWeight) - weight);
  const upright = storage.font.variants.filter((v) => v.fontStyle === "normal");
  storage.font.applyToText(text, upright.sort((a, b) => far(a) - far(b))[0]);
  text.name = characters.slice(0, 30);
  text.fontSize = String(size);
  text.lineHeight = size >= 32 ? "1.15" : "1.5";
  text.fills = [{ fillColor: color, fillOpacity: 1 }];
  if (wrap) {
    text.layoutChild.horizontalSizing = "fill";
    text.growType = "auto-height";
  }
  return text;
};
```

2. Board, page-wide header, centred 1440 column (side padding 240 = (1920 - 1440) / 2):

```js
return storage.step(() => {
  const x = Math.max(0, ...penpot.root.children.map((s) => s.x + s.width + 100));
  const board = penpot.createBoard();
  storage.board = board;
  board.name = "Home";
  board.resize(1920, 1080);
  board.x = x;
  board.y = 0;
  board.addFlexLayout().dir = "column";
  board.verticalSizing = "auto";
  const header = storage.box(board, "Header", "row", { padX: 240, padY: 24 });
  header.flex.justifyContent = "space-between";
  header.flex.alignItems = "center";
  storage.text(header, "Nordlys", 24, { weight: 700, wrap: false });
  const nav = storage.box(header, "Navigation", "row", { gap: 32, width: "auto" });
  for (const label of ["Rooms", "Prices"]) storage.text(nav, label, 18, { wrap: false });
  const hero = storage.box(board, "Hero", "column", { gap: 24, padX: 240, padY: 128, fill: "#F6F1E7" });
  storage.text(hero, "Cabins by the fjord", 72, { weight: 600 });
  storage.text(hero, "Twelve cabins, one hour from Bergen.", 20, { color: "#475467" });
  return { board: board.id, hero: hero.id };
});
```

3. Section with cards (corners, border, shadow):

```js
return storage.step(() => {
  const section = storage.box(storage.board, "Cabins", "column", { gap: 48, padX: 240, padY: 96 });
  storage.text(section, "Choose your cabin", 40, { weight: 600 });
  const row = storage.box(section, "Cards", "row", { gap: 24 });
  for (const [title, body] of [["Shore", "Two beds and a sauna."], ["Forest", "Four beds and a stove."]]) {
    const card = storage.box(row, `${title} Card`, "column", { gap: 12, padX: 32, padY: 32, fill: "#FFFFFF" });
    card.borderRadius = 16;
    card.strokes = [{ strokeColor: "#D0D5DD", strokeOpacity: 1, strokeWidth: 1, strokeStyle: "solid", strokeAlignment: "inner" }];
    card.shadows = [{ style: "drop-shadow", offsetX: 0, offsetY: 8, blur: 24, spread: 0, color: { color: "#101828", opacity: 0.1 } }];
    storage.text(card, title, 24, { weight: 600 });
    storage.text(card, body, 18, { color: "#475467" });
  }
  return { section: section.id };
});
```

4. Leftovers: list what lies on the page, then remove by id what you made by mistake, nothing else:

```js
return penpot.root.children.map((s) => ({ id: s.id, type: s.type, name: s.name, children: s.children?.length }));
```

```js
for (const id of ["<id from the list>"]) penpotUtils.findShapeById(id)?.remove();
```

## Layout

- Use flex for everything: page = column of sections, section = column with side padding (240 for a
  1440 column on 1920), cards = row with `columnGap`; a grid of 6 cards = two rows of three.
- Every flex box has a gap (text block 12-16, cards 24-32, section 48) and every box with a fill,
  border or radius has padding (button 24 x 12, card 32, section 96-128 high). Text never touches an
  edge. A button is a box with padding around its text, not a rectangle of fixed size.
- Text: desktop h1 56-80, h2 36-48, h3 22-28, body 16-20; tablet h1 44-56, h2 30-36, body 16-18;
  mobile h1 32-40, h2 24-28, body 16. Nothing under 14.
- Space: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128; on mobile 48-64 between sections, side margin 16-24.
  One left edge for all sections.
- Order in a section: label, heading, one sentence, content, action. Every section has a heading and
  one idea; neighbours differ in ground or structure. One accent colour, for the main action only.
- Nothing covers text: a mockup gets its own column, and draw its inside (bars, rows, prices); an
  empty box with a caption is no mockup.
- Contrast 4.5:1 or more. Never grey on grey.

## Honest report

Say what you made and what the last screenshot showed. Name what you did not check, what failed and
what is missing. Never say "done" about something no screenshot showed.
