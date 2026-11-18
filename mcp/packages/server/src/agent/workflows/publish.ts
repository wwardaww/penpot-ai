import type { Workflow } from "@penpot/mcp-common";
import { PublishRun } from "../publish/PublishRun";
import { PublishServices } from "../publish/PublishServices";

/**
 * Share and publish the generated app (W20): ZIP download, GitHub, Vercel, Netlify, phone
 * preview, and the provider accounts. Params and events: `wiki/architecture.md` §7 and
 * {@link PublishRun}.
 */
export const workflow: Workflow<Record<string, unknown>> = {
    name: "publish",
    description: "Download, push to GitHub, deploy to Vercel or Netlify, or open the app on a phone.",
    run: async (ctx, params) => new PublishRun(ctx, PublishServices.get()).run(params),
};
