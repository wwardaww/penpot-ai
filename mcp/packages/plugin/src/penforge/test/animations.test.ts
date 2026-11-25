import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ANIMATION_KEY,
    ANIMATION_NAMESPACE,
    AnimationReader,
    encodeAnimationSpec,
    parseAnimationSpec,
    validateAnimationSpec,
} from "../animations.ts";
import type { AnimationSpec } from "../animations.ts";

/** A shape with shared plugin data and children, enough for the read helpers. */
function shape(name: string, data: Record<string, string> = {}, children: any[] = [], extra: any = {}): any {
    const s: any = {
        id: `id-${name}`,
        name,
        type: children.length ? "board" : "rectangle",
        children,
        interactions: [],
        getSharedPluginData(namespace: string, key: string): string | undefined {
            return namespace === ANIMATION_NAMESPACE ? data[key] : undefined;
        },
        ...extra,
    };
    for (const child of children) {
        child.parent = s;
    }
    return s;
}

const cardEntrance: AnimationSpec = {
    v: 1,
    entrance: {
        effects: [{ type: "fade" }, { type: "slide", direction: "up", distance: 24 }],
        duration: 300,
        easing: "ease-out",
        stagger: { each: 50 },
    },
};

test("a full spec validates", () => {
    const spec: AnimationSpec = {
        v: 1,
        entrance: {
            effects: [{ type: "scale", from: 0.9 }],
            duration: 250,
            delay: 100,
            easing: { type: "spring", stiffness: 200, damping: 20 },
        },
        exit: { effects: [{ type: "blur", amount: 6 }], duration: 200 },
        states: {
            hover: { scale: 1.05, offsetY: -2, fill: "#112233", shadow: { offsetY: 8, blur: 24, opacity: 0.2 } },
            press: { scale: 0.97, duration: 80, easing: "ease-in" },
        },
        loop: { type: "spin", duration: 900, count: "infinite" },
        smart: [{ index: 0, destination: "board-2", duration: 300, easing: "ease-in-out" }],
    };
    assert.deepEqual(validateAnimationSpec(spec), { ok: true, spec });
});

test("keyframe tracks validate (later keyframe editor)", () => {
    const spec = {
        v: 1,
        entrance: {
            duration: 400,
            tracks: [
                {
                    prop: "opacity",
                    keyframes: [
                        { at: 0, value: 0 },
                        { at: 1, value: 1, easing: "ease" },
                    ],
                },
                {
                    prop: "fill",
                    keyframes: [
                        { at: 0, value: "#000000" },
                        { at: 1, value: "#ffffff" },
                    ],
                },
            ],
        },
    };
    assert.equal(validateAnimationSpec(spec).ok, true);
});

test("invalid specs report JSON paths", () => {
    const result = validateAnimationSpec({
        v: 1,
        entrance: { effects: [{ type: "wobble" }], duration: -1 },
        loop: { type: "pulse", count: 0 },
        extra: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.errors.some((e) => e.startsWith("$.extra")));
        assert.ok(result.errors.some((e) => e.startsWith("$.entrance.effects[0].type")));
        assert.ok(result.errors.some((e) => e.startsWith("$.entrance.duration")));
        assert.ok(result.errors.some((e) => e.startsWith("$.loop.count")));
    }
});

test("wrong version and missing duration are refused", () => {
    assert.equal(validateAnimationSpec({ v: 2 }).ok, false);
    assert.equal(validateAnimationSpec({ v: 1, entrance: { effects: [{ type: "fade" }] } }).ok, false);
    assert.equal(validateAnimationSpec({ v: 1, loop: { type: "pulse", count: 1.5 } }).ok, false);
    assert.equal(validateAnimationSpec({ v: 1, states: { hover: { fill: "red" } } }).ok, false);
});

test("parse ignores missing, broken and invalid values", () => {
    assert.equal(parseAnimationSpec(undefined), null);
    assert.equal(parseAnimationSpec(""), null);
    assert.equal(parseAnimationSpec("{not json"), null);
    assert.equal(parseAnimationSpec(JSON.stringify({ v: 1, loop: { type: "nope" } })), null);
    assert.deepEqual(parseAnimationSpec(JSON.stringify(cardEntrance)), cardEntrance);
});

test("encode round-trips, drops empty sections and returns null when empty", () => {
    const raw = encodeAnimationSpec({ ...cardEntrance, states: {}, smart: [] });
    assert.ok(raw);
    assert.deepEqual(JSON.parse(raw!), cardEntrance);
    assert.equal(encodeAnimationSpec({ v: 1 }), null);
    assert.equal(encodeAnimationSpec({ v: 1, states: {} }), null);
    assert.throws(() => encodeAnimationSpec({ v: 1, loop: { type: "nope" } } as any), /Invalid animation spec/);
});

test("collect lists animated layers with name paths", () => {
    const title = shape("Title", { [ANIMATION_KEY]: JSON.stringify({ v: 1, loop: { type: "pulse" } }) });
    const broken = shape("Broken", { [ANIMATION_KEY]: "{oops" });
    const card = shape("Card", { [ANIMATION_KEY]: JSON.stringify(cardEntrance) }, [title, broken]);
    const screen = shape("Home", {}, [card]);

    const layers = AnimationReader.collect(screen);
    assert.deepEqual(
        layers.map((l) => [l.nodeId, l.path, l.parentId]),
        [
            ["id-Card", "Card", "id-Home"],
            ["id-Title", "Card/Title", "id-Card"],
        ]
    );
    assert.deepEqual(layers[0].animations, cardEntrance);
    assert.equal(AnimationReader.raw(broken), "{oops");
    assert.equal(AnimationReader.read(broken), null);
    assert.equal(AnimationReader.read(screen), null);
});

test("smartFor matches the interaction index and destination", () => {
    const spec = { v: 1, smart: [{ index: 0, destination: "id-B", duration: 300 }] };
    const button = shape("Button", { [ANIMATION_KEY]: JSON.stringify(spec) }, [], {
        interactions: [{ trigger: "click", action: { type: "navigate-to", destination: { id: "id-B" } } }],
    });
    assert.deepEqual(AnimationReader.smartFor(button, 0), spec.smart[0]);
    assert.equal(AnimationReader.smartFor(button, 1), null);

    button.interactions = [{ trigger: "click", action: { type: "navigate-to", destination: { id: "id-C" } } }];
    assert.equal(AnimationReader.smartFor(button, 0), null);
});
