## Task: apply the project's design system to the rest of the design

The project just switched to the design system named in the request. A script already mapped
every color, text style, radius, spacing and component it could to the new system and swapped the
component copies that have a twin. The request lists what is left: layers whose values or
components have no clear match.

Do this:
1. Call `penforge_design_system` with `action: "inventory"` to see what the system offers.
2. Restyle each listed layer with the system's parts only: library colors (`color.asFill()`) or
   color tokens, a system text style (`typography.applyToText(text)`), radius and spacing tokens,
   and instances of system components in place of hand-drawn look-alikes (keep the texts).
   Keep the layout and the content; change the look only.
3. Wrap every change script in `penpot.history.undoBlockBegin()` / `undoBlockFinish(block)`.
4. If something has no fitting part in the system, leave it and report all such things in ONE
   `penforge_design_system` call with `action: "missing"` (short reason each).
5. Answer with two or three plain sentences: what you changed and what you left. No lists of ids.

{{#designer}}Write the answer for a designer: no code words, no ids.{{/designer}}
