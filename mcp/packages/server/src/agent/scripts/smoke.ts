/**
 * Manual check of a running Penforge daemon: pair, authenticate, set a context, chat once.
 *
 * Usage (from mcp/packages/server, daemon started with `PENFORGE=1 pnpm run start`):
 *   npx tsx src/agent/scripts/smoke.ts "list the boards on this page" [--session <mcpSessionId>]
 *     [--project <id>] [--file <id>] [--page <id>] [--persona designer|developer] [--allow]
 *     [--url http://127.0.0.1:4410] [--origin https://localhost:3449]
 *
 * Prints the streamed answer and tool calls. Permission requests are denied unless `--allow` is given.
 */
import { randomUUID } from "crypto";
import { AgentTestClient } from "../testing/AgentTestClient";

function option(args: string[], name: string, fallback: string): string {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const text = args[0] && !args[0].startsWith("--") ? args[0] : "Say hello in five words.";
    const baseUrl = option(args, "url", "http://127.0.0.1:4410");
    const origin = option(args, "origin", "https://localhost:3449");
    const persona = option(args, "persona", "developer") as "designer" | "developer";
    const allow = args.includes("--allow");

    const pair = (await (await fetch(`${baseUrl}/pair`)).json()) as { pairUrl: string };
    const token = new URL(pair.pairUrl.replace("/#/", "/")).searchParams.get("token")!;
    const client = await AgentTestClient.connect(`${baseUrl.replace(/^http/, "ws")}/agent`, origin);
    client.send({ type: "auth", token });
    const ok = await client.next("auth.ok");
    console.log(`[auth.ok] daemon ${ok.daemonVersion}`);

    client.send({
        type: "context.set",
        fileId: option(args, "file", "smoke-file"),
        fileName: "Smoke test",
        projectId: option(args, "project", "smoke-project"),
        projectName: "Smoke test",
        teamId: "smoke-team",
        pageId: option(args, "page", "smoke-page"),
        persona,
        platform: "web",
        mcpSessionId: args.includes("--session") ? option(args, "session", "") : undefined,
    });

    const conversationId = `smoke-${randomUUID()}`;
    client.send({ type: "chat.send", rid: "smoke", conversationId, text });
    const timeoutMs = 10 * 60_000;
    const started = Date.now();
    for (;;) {
        const remaining = timeoutMs - (Date.now() - started);
        const message = await client.nextAny(remaining);
        switch (message.type) {
            case "chat.delta":
                process.stdout.write(message.text);
                break;
            case "chat.tool":
                console.log(
                    `\n[tool ${message.status}] ${message.summary}${message.detail ? `\n${message.detail}` : ""}`
                );
                break;
            case "permission.request":
                console.log(`\n[permission ${message.risk}] ${message.title} ${message.description} -> ${allow}`);
                client.send({ type: "permission.respond", requestId: message.requestId, allow });
                break;
            case "error":
                console.log(`\n[error ${message.code}] ${message.message}`);
                break;
            case "chat.done":
                console.log(`\n[chat.done] usage ${JSON.stringify(message.usage ?? {})}`);
                client.close();
                process.exit(0);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
