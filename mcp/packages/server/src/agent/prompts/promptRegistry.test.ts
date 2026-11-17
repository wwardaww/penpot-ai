import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptRegistry } from "./promptRegistry";

test("renders placeholders and keeps only the sections of the current persona and platform", () => {
    const registry = new PromptRegistry("unused", "unused");
    const template =
        "{{projectName}} for {{platform}}\n{{#designer}}\nplain words\n{{/designer}}\n{{#developer}}\ncode\n{{/developer}}\n{{#mobile}}\nsafe area\n{{/mobile}}\nend";
    const rendered = registry.render(template, { persona: "designer", platform: "mobile", projectName: "Shop" });
    assert.equal(rendered, "Shop for mobile\nplain words\nsafe area\nend");
});

test("builds the chat prompt from the shipped files", () => {
    const registry = PromptRegistry.locate();
    const prompt = registry.build({
        persona: "developer",
        platform: "web",
        projectName: "Shop",
        workflow: "chat",
        extra: "## Tab",
    });
    assert.match(prompt, /^# Penforge/);
    assert.match(prompt, /Project: Shop\. Target platform: web\./);
    assert.match(prompt, /a developer/);
    assert.doesNotMatch(prompt, /a designer/);
    assert.match(prompt, /Task: free chat/);
    assert.match(prompt, /## Tab\n$/);
    assert.doesNotMatch(prompt, /\{\{/);
});

test("a workflow without a prompt file adds nothing", () => {
    const registry = PromptRegistry.locate();
    assert.equal(registry.workflowPrompt("no-such-workflow"), null);
});

test("refuses workflow prompt names with path characters", () => {
    const registry = PromptRegistry.locate();
    assert.throws(() => registry.workflowPrompt("../base"), /Invalid workflow prompt name/);
});
