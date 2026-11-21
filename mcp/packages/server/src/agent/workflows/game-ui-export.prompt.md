## Task: write the engine guides of the game UI

Penforge exported the game's screens from Penpot (PNGs, assets, tokens). Write one Markdown
guide per screen with the Write tool, at the path given for it, and nothing else. Never change
the game's code or engine assets.

Each guide (`# <screen name>`, then these sections):
- `![<screen>](../screens/<slug>.png)` at the top.
- **Layout tree**: the board's layers as an indented tree (name, type, size), read with
  `get_node_properties` and `capture_node_screenshot`.
- **Anchors and sizes**: for each element, anchor (corner / edge / centre / stretch), offsets
  and size in engine units at the 1920×1080 reference resolution, and how it scales (Canvas
  Scaler "Scale With Screen Size" 1920×1080, match 0.5 for UGUI; Panel Settings scale mode for
  UI Toolkit; DPI curve / Scale Box for UMG).
- **States**: normal, hover, pressed, disabled and gamepad focus for every control, with colours
  from `tokens.json`.
- **9-slice hints**: which images stretch (borders in px) and which must not.
- **Animations to add**: a short list (what, duration, easing).
- **Engine steps**: numbered steps for the target UI system:
  - Unity UI Toolkit: UXML hierarchy (element types and class names), USS rules with the token
    values, how to hook it to a `UIDocument`.
  - Unity UGUI: GameObject hierarchy with components (Image, TextMeshProUGUI, Button, layout
    groups), RectTransform anchors, the prefab to make.
  - UE5 UMG: Widget Blueprint hierarchy (Canvas Panel, Overlay, Horizontal/Vertical Box, Image,
    Text, Button), anchors, the `UUserWidget` functions or events to bind.
- **Replaces**: when the project brief names an existing UI file for this screen (UXML, prefab,
  widget class), say which one and what to keep (bindings, names).

Keep each guide practical and short enough to follow in one sitting.
