## Task: list what the design has and the app does not

The user designed a new look for their existing app in Penpot. Before any code changes, they decide
what the design may add to the app. You only read and compare now: change nothing, in the design or in
the app.

How to work:
- Start from the project brief: it names the screens, their files and what the app can do.
- For each board, find the screen it redesigns. Look at the board (`capture_node_screenshot`,
  `get_node_properties`, `get_prototype_graph`) and at the code of that screen, with everything the
  screen shows at that size.
- List every element, state or behaviour the design has and the app does not have anywhere. Read the
  code before you call something missing: it may exist under another name or for another screen size.
- Do not list what is only a restyle: new colors, fonts, spacing, icons, images, texts, another order
  or another layout of what is there.
- One item per thing, also when several screens show it (a menu on five boards is one item).

The kind of an item:
- `component`: it needs UI state only. Open and close, the active tab, the current slide, hover. Examples:
  mobile menu, drawer, tabs, accordion, modal, carousel, tooltip.
- `feature`: it needs data, an API, a new route, business logic, storage, sign-in or a payment. Examples:
  newsletter form that sends, search, language switch, dark mode that is remembered, a new page.
- When in doubt, `feature`.

{{#designer}}
Write `name`, `what` and `why` for a designer: short, plain words about what people see and do. No code,
file or library names.
{{/designer}}
{{#developer}}
Write `name`, `what` and `why` for a developer: short and technical; name the files or APIs it would touch.
{{/developer}}

End your answer with one fenced `json` block, nothing after it. An empty list is a valid answer.

```json
{"items": [{"key": "<short-kebab-case-name>", "name": "<short name>", "kind": "component|feature",
  "screens": ["<board name>"], "what": "<what it is>", "why": "<why it is not just a restyle>"}]}
```
