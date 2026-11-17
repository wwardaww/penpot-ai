import { FakeComponent, type FakePenpot } from "./FakePenpot";

/**
 * Acceptance fixture of W22: 8 colors, 4 text styles, a spacing scale and a Button spec, written
 * in the serializer's canonical form.
 */
export const ACME_DESIGN_MD = `---
version: alpha
name: Acme Design
description: "Calm, trustworthy product design for Acme."
colors:
  primary: "#2B59C3"
  on-primary: "#FFFFFF"
  secondary: "#F4A259"
  surface: "#FAFAF7"
  on-surface: "#1B1B1F"
  outline: "#C4C6D0"
  error: "#BA1A1A"
  link: "{colors.primary}"
typography:
  display-lg:
    fontFamily: Work Sans
    fontSize: 2.5rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.5px
  headline-md:
    fontFamily: Work Sans
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
  body-md:
    fontFamily: Work Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Work Sans
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0.02em
rounded:
  sm: 4px
  md: 8px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  columns: 12
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: 12px 24px
    height: 44px
---

## Overview

Calm and clear. Plenty of white space, one strong accent.

## Colors

\`primary\` is for actions only. Text sits on \`surface\` in \`on-surface\`.

## Typography

Work Sans everywhere. \`display-lg\` once per page at most.

## Layout

8px grid. 12 columns on desktop, 4 on mobile.

## Components

### button-primary

Main call to action. One per screen.

## Do's and Don'ts

- Do keep one primary button per screen.
- Don't put \`primary\` text on \`secondary\`.
`;

/**
 * Builds the `button-primary` main component in a fake file the way Claude would after an
 * import: library colors and tokens applied, label text with the `label-md` style.
 */
export function buildButton(penpot: FakePenpot, name: string = "button-primary"): FakeComponent {
    const library = penpot.library.local;
    const primary = library.color("primary");
    const onPrimary = library.color("on-primary");
    const label = library.typography("label-md");
    const component = new FakeComponent(name, "", {
        type: "board",
        width: 132,
        height: 44,
        borderRadius: 8,
        fills: [{ fillColor: primary?.color, fillOpacity: 1, fillColorRefId: primary?.id }],
        tokens: {
            fill: "color.primary",
            borderRadiusTopLeft: "radius.md",
            borderRadiusTopRight: "radius.md",
            borderRadiusBottomRight: "radius.md",
            borderRadiusBottomLeft: "radius.md",
        },
        flex: { topPadding: 12, rightPadding: 24, bottomPadding: 12, leftPadding: 24 },
        children: [
            {
                type: "text",
                width: 84,
                height: 18,
                fills: [{ fillColor: onPrimary?.color, fillOpacity: 1, fillColorRefId: onPrimary?.id }],
                tokens: { fill: "color.on-primary" },
                fontFamily: label?.fontFamily,
                fontSize: label?.fontSize,
                fontWeight: label?.fontWeight,
                lineHeight: label?.lineHeight,
                letterSpacing: label?.letterSpacing,
            },
        ],
    });
    library.components.push(component);
    return component;
}
