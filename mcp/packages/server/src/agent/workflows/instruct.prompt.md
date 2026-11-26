## Task: write the notes of the screen guides

Penforge exported the design's screens from Penpot and wrote each guide's design data itself: the
layer tree with sizes, layouts, colours and tokens, the flows, the animations and the assets. A
developer will build the {{platform}} app from them, with a stack of their choice. You add only
what needs judgement. Use no tool: the message holds an outline of every screen (its layers and
texts, and the flows between screens). Write no code and no files; never change the design.

Answer with one block per screen, in the order given. Each block starts with the line
`=== <id> ===` (the id from the message), then one sentence on what the screen is for, then these
sections, each under its `## ` heading:
{{#web}}
- `## Breakpoints`: how the screen changes from desktop to tablet to phone. Use the other boards of
  the same screen when the file has them (their names and sizes are listed); otherwise derive it
  from the layout and say so. Name the widths, what stacks, hides or scrolls, and the maximum width.
- `## States`: normal, hover, focus, pressed and disabled for the controls; empty, loading and
  error for lists and forms. Name the state screens of the file that apply; say when a state is not
  drawn.
{{/web}}
{{#mobile}}
- `## Screen sizes and safe areas`: what sticks to the top or bottom, safe area insets, what
  scrolls, how the screen fits small and large phones, and what the keyboard covers.
- `## States`: normal, pressed and disabled for the controls; empty, loading and error for lists
  and forms. Name the state screens of the file that apply; say when a state is not drawn.
{{/mobile}}
- `## Accessibility`: labels of icon buttons, heading order, reading order, contrast to watch.
- `## Build order`: short numbered steps for the developer, without naming a framework.

Keep each block short and concrete: name the layers as the outline does, no values the guide
already lists, no introduction and nothing after the last block.
