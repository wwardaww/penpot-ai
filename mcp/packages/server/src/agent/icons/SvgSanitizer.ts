/**
 * Rebuilds an icon SVG from an allowlist of shape elements and presentation attributes, so that
 * nothing active reaches Penpot: no scripts, styles, event handlers, links, external references,
 * embedded images, foreign content, entities or text. The output is a new string written by this
 * code; nothing of the input is copied that was not checked.
 */

/** Result of {@link sanitizeSvg}. */
export type SanitizedSvg = { ok: true; svg: string; removed: number } | { ok: false; reason: SvgRejectReason };

/** Why an SVG was refused. */
export type SvgRejectReason = "not-svg" | "malformed" | "empty" | "too-large";

/** Elements kept, with their children. */
const ELEMENTS = new Set([
    "svg",
    "g",
    "path",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "rect",
    "defs",
    "clipPath",
    "mask",
    "linearGradient",
    "radialGradient",
    "stop",
]);

/** Elements dropped silently with everything inside them (no warning: they are common). */
const QUIET_DROP = new Set(["title", "desc", "metadata"]);

/** Attributes kept (values checked one by one). */
const ATTRIBUTES = new Set([
    "d",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "fx",
    "fy",
    "width",
    "height",
    "points",
    "viewBox",
    "transform",
    "pathLength",
    "preserveAspectRatio",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "fill-rule",
    "fill-opacity",
    "clip-rule",
    "opacity",
    "vector-effect",
    "id",
    "clip-path",
    "mask",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "clipPathUnits",
    "maskUnits",
    "maskContentUnits",
    "display",
    "visibility",
]);

/** Properties kept from a `style` attribute (written back as attributes). */
const STYLE_PROPERTIES = new Set([
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "fill-rule",
    "fill-opacity",
    "clip-rule",
    "opacity",
    "stop-color",
    "stop-opacity",
    "display",
    "visibility",
]);

const PREDEFINED_ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});/g;
const MAX_INPUT = 5 * 1024 * 1024;
const MAX_DEPTH = 64;

/**
 * Sanitizes one SVG file.
 *
 * @param input - the file text
 * @param options.paint - replaces `currentColor` (default `#000000`, so that Penpot gets a color
 *   it can bind a token to)
 */
export function sanitizeSvg(input: string, options: { paint?: string } = {}): SanitizedSvg {
    if (input.length > MAX_INPUT) {
        return { ok: false, reason: "too-large" };
    }
    const paint = options.paint ?? "#000000";
    const out: string[] = [];
    const stack: { name: string; kept: boolean }[] = [];
    let skipDepth = 0;
    let removed = 0;
    let sawRoot = false;
    let rootClosed = false;
    let shapes = 0;
    let index = 0;
    const text = input.replace(/^﻿/, "");

    while (index < text.length) {
        const open = text.indexOf("<", index);
        if (open === -1) {
            break;
        }
        // text between tags is dropped (icons carry no text)
        if (text.startsWith("<!--", open)) {
            const end = text.indexOf("-->", open + 4);
            if (end === -1) {
                return { ok: false, reason: "malformed" };
            }
            index = end + 3;
            continue;
        }
        if (text.startsWith("<![CDATA[", open)) {
            const end = text.indexOf("]]>", open + 9);
            if (end === -1) {
                return { ok: false, reason: "malformed" };
            }
            index = end + 3;
            removed++;
            continue;
        }
        if (text.startsWith("<?", open)) {
            const end = text.indexOf("?>", open + 2);
            if (end === -1) {
                return { ok: false, reason: "malformed" };
            }
            index = end + 2;
            continue;
        }
        if (text.startsWith("<!", open)) {
            // DOCTYPE, with an optional internal subset in brackets: dropped, entities never expanded
            const end = skipDeclaration(text, open);
            if (end === -1) {
                return { ok: false, reason: "malformed" };
            }
            index = end;
            continue;
        }
        const close = findTagEnd(text, open + 1);
        if (close === -1) {
            return { ok: false, reason: "malformed" };
        }
        const raw = text.slice(open + 1, close);
        index = close + 1;

        if (raw.startsWith("/")) {
            const name = localName(raw.slice(1).trim());
            const top = stack.pop();
            if (!top || top.name !== name) {
                return { ok: false, reason: "malformed" };
            }
            if (skipDepth > 0) {
                skipDepth--;
            } else if (top.kept) {
                out.push(`</${name}>`);
            }
            if (stack.length === 0) {
                rootClosed = true;
            }
            continue;
        }

        const selfClosing = raw.endsWith("/");
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const nameMatch = body.match(/^\s*([^\s/>]+)/);
        if (!nameMatch) {
            return { ok: false, reason: "malformed" };
        }
        const qualified = nameMatch[1];
        const name = localName(qualified);
        if (!sawRoot) {
            if (name !== "svg") {
                return { ok: false, reason: "not-svg" };
            }
            sawRoot = true;
        } else if (rootClosed) {
            return { ok: false, reason: "malformed" };
        }
        if (stack.length >= MAX_DEPTH) {
            return { ok: false, reason: "malformed" };
        }

        const prefixed = qualified.includes(":") && !qualified.startsWith("svg:");
        const kept = skipDepth === 0 && !prefixed && ELEMENTS.has(name);
        if (!kept && skipDepth === 0 && !QUIET_DROP.has(name)) {
            removed++;
        }
        if (kept) {
            const attributes = sanitizeAttributes(body.slice(nameMatch[0].length), name, paint);
            removed += attributes.removed;
            if (name !== "svg" && name !== "g" && name !== "defs" && name !== "stop") {
                shapes++;
            }
            const head =
                name === "svg"
                    ? `<svg xmlns="http://www.w3.org/2000/svg"${attributes.text}`
                    : `<${name}${attributes.text}`;
            out.push(selfClosing ? `${head}/>` : `${head}>`);
        }
        if (!selfClosing) {
            stack.push({ name, kept });
            if (!kept) {
                skipDepth++;
            }
        } else if (stack.length === 0) {
            rootClosed = true;
        }
    }

    if (!sawRoot) {
        return { ok: false, reason: "not-svg" };
    }
    if (stack.length > 0) {
        return { ok: false, reason: "malformed" };
    }
    if (shapes === 0) {
        return { ok: false, reason: "empty" };
    }
    return { ok: true, svg: out.join(""), removed };
}

function localName(qualified: string): string {
    return qualified.startsWith("svg:") ? qualified.slice(4) : qualified;
}

function findTagEnd(text: string, from: number): number {
    let quote: string | null = null;
    for (let index = from; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "<") {
            return -1;
        } else if (char === ">") {
            return index;
        }
    }
    return -1;
}

function skipDeclaration(text: string, open: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = open + 2; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "[") {
            depth++;
        } else if (char === "]") {
            depth--;
        } else if (char === ">" && depth <= 0) {
            return index + 1;
        }
    }
    return -1;
}

function sanitizeAttributes(source: string, element: string, paint: string): { text: string; removed: number } {
    const values = new Map<string, string>();
    let removed = 0;
    const pattern = /([^\s=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const name = match[1];
        const value = match[2] ?? match[3] ?? match[4];
        if (value === undefined) {
            removed++;
            continue;
        }
        if (name === "style") {
            for (const declaration of value.split(";")) {
                const colon = declaration.indexOf(":");
                if (colon === -1) {
                    continue;
                }
                const property = declaration.slice(0, colon).trim().toLowerCase();
                const propertyValue = declaration.slice(colon + 1).trim();
                const safe = STYLE_PROPERTIES.has(property) ? safeValue(property, propertyValue, paint) : null;
                if (safe === null) {
                    removed++;
                } else if (!values.has(property)) {
                    values.set(property, safe);
                }
            }
            continue;
        }
        if (name.startsWith("xmlns") || name === "version" || name === "class" || name === "data-name") {
            continue;
        }
        if (!ATTRIBUTES.has(name)) {
            removed++;
            continue;
        }
        if (element === "svg" && (name === "x" || name === "y")) {
            continue;
        }
        const safe = safeValue(name, value, paint);
        if (safe === null) {
            removed++;
            continue;
        }
        // attributes win over the style attribute's copy only when they come later; keep the first
        values.set(name, safe);
    }
    let text = "";
    for (const [name, value] of values) {
        text += ` ${name}="${value}"`;
    }
    return { text, removed };
}

function safeValue(name: string, raw: string, paint: string): string | null {
    if (raw.length > 200_000) {
        return null;
    }
    // only XML's predefined entities and numeric references are allowed; nothing is expanded
    if (raw.replace(PREDEFINED_ENTITY, "").includes("&")) {
        return null;
    }
    const value = raw.trim();
    const lowered = value.toLowerCase();
    if (
        /[<>"`\\]/.test(value) ||
        lowered.includes("javascript:") ||
        lowered.includes("data:") ||
        lowered.includes("expression(")
    ) {
        return null;
    }
    if (lowered.includes("url(")) {
        return /^url\(\s*#[A-Za-z0-9_.:-]+\s*\)$/.test(value) ? value : null;
    }
    if (name === "id") {
        return /^[A-Za-z_][A-Za-z0-9_.:-]{0,100}$/.test(value) ? value : null;
    }
    if (lowered === "currentcolor") {
        return paint;
    }
    return value;
}
