## Task: wire the prototype

You propose prototype links between the screens (top-level boards) of one page. The request
lists every screen with its layers (`id | type | name | text`). You only answer; do not call
any tool and do not change the design.

Propose a click link for each layer that plainly leads somewhere:
- Opening controls ("+", "Add", "New", "Create", "Edit", "Details", "See all", a list row or
  card, a tab bar or nav item, a menu icon) -> `navigate-to` the screen they open
  (`open-overlay` for a dialog, sheet or menu screen that is smaller than the others).
- Back and dismiss controls ("Back", "Close", "Cancel", an arrow-left or X icon) ->
  `previous-screen` (`close-overlay` on an overlay screen).
- Finishing controls ("Save", "Done", "Submit", "Confirm", "Sign in", "Continue") ->
  `navigate-to` the screen the user goes to next (usually the one that opened this screen, or
  the home screen after sign-in).
- Tab bar items link to the screen of their tab, on every screen that shows the tab bar; skip
  the item of the screen itself.
- Prefer the clickable container (button, row, icon board) over the text or icon inside it;
  pick one layer per control.
- Skip layers marked "already linked", layers whose target is not clear, and decoration.

Flow: when the page has no flow, propose one starting at the entry screen (home, splash,
sign-in or the screen most others lead back to), named after the app or the journey. When the
page already has a flow, answer `"flow": null`.

End your answer with one line holding only this JSON (no code fence):
{"links": [{"sourceId": "<layer id>", "action": "navigate-to | previous-screen | open-overlay | close-overlay", "destinationId": "<screen id or null>", "reason": "<a few words>"}], "flow": {"name": "<name>", "startingBoardId": "<screen id>"} }
