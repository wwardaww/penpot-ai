## Task: write the screen guides of the specification

Penforge exported the design's screens from Penpot (PNGs, assets, tokens). A developer will build
the {{platform}} app from them, with a stack of their choice. Write one Markdown guide per screen
with the Write tool, at the path given for it, and nothing else. Write no source code and no files
of an app; single values (colours, sizes, durations) are fine. Never change the design.

Read each screen with `get_node_properties` and look at its PNG before you write. Take exact
values from the design and name the token in `tokens.json` when one matches.

Each guide (`# <screen name>`, then these sections):
- `![<screen>](../screens/<slug>.png)` at the top, then one sentence on what the screen is for.
- **Layout tree**: the board's layers as an indented tree (name, kind, direction, gap, padding,
  size, alignment).
- **Sizes**: exact sizes, spacing, radii, colours and type styles of each part, with token names;
  which parts have a fixed size and which grow or wrap.
{{#web}}
- **Breakpoints**: how the screen changes from desktop to tablet to phone. Use the other boards of
  the same screen when the file has them (their names and sizes are listed); otherwise derive it
  from the layout and say so. Name the widths, what stacks, hides or scrolls, and the maximum width.
- **States**: normal, hover, focus, pressed and disabled for every control; empty, loading and error
  for lists and forms. Use the variants in the design; say when a state is not drawn.
{{/web}}
{{#mobile}}
- **Screen sizes and safe areas**: what sticks to the top or bottom, safe area insets, what scrolls,
  how the screen fits small and large phones, and what the keyboard covers.
- **States**: normal, pressed and disabled for every control; empty, loading and error for lists and
  forms. Use the variants in the design; say when a state is not drawn.
{{/mobile}}
- **Flows**: what each control opens, from the navigation file (screen names, trigger, transition);
  where the user comes from and how they go back.
- **Animations**: every animation of this screen from the animations file (layer, trigger, effect,
  duration, delay, easing, loop). Leave the section out when there is none.
- **Assets**: the files in `assets/` this screen uses, with their size on the screen.
- **Accessibility**: labels of icon buttons, heading order, reading order, contrast to watch.
- **Build order**: short numbered steps for the developer, without naming a framework.

Keep each guide practical: complete values, short sentences.
