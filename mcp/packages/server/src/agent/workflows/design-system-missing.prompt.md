## Task: add missing items to this design system

This file is a design system (a Penpot shared library). A project that uses it needs the items
listed in the request, and the user chose "Add to design system". The request shows what the
project's own version of each item looks like today: use it only to understand what the item is
for. Do NOT copy it.

For each item, make a NEW component that belongs to this system:
1. This file IS the system, so read it with `execute_code` (`penpot.library.local`: colors,
   typographies, components, tokens) and look at one or two existing components so the new one
   matches them.
2. Build the item from the system's parts only: its library colors (`color.asFill()`) or color
   tokens, its text styles (`typography.applyToText(text)`), its radius and spacing tokens, and
   instances of its existing components (a "Delete button" is a variant or an instance of the
   system's button, not a new drawing). Use flex layout like the other components.
3. Put it on the page "Components" (create the page if there is none), next to the other
   components, and make it a main component with `penpot.library.local.createComponent([shape])`
   named after the item (keep the system's naming style, e.g. `Buttons / Delete`).
4. Tag the main: `main.setSharedPluginData("penforge", "designSystemItem", "<item id>")` with the
   item id from the request. Untagged components are not picked up.
5. One `penpot.history.undoBlockBegin()` / `undoBlockFinish(block)` per item.

Answer with one short sentence per item: what you made. If an item cannot be made from the
system's parts, say why in one sentence and skip it.
