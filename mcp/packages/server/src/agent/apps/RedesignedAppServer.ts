import { AgentError } from "../AgentClient";
import type { CommandPolicy } from "../process/CommandPolicy";
import type { DevServerTarget } from "../process/DevServerTarget";
import type { StackConfig } from "../process/StackConfig";
import { LinkedAppStack } from "./LinkedAppStack";

/**
 * Dev server target of a Re-Designed app (W39): its app folder inside the project's linked folder,
 * run on whatever branch the folder has checked out (Penforge never switches it).
 */
export class RedesignedAppServer implements DevServerTarget {
    /**
     * @param projectId - the app id (key of the dev server)
     * @param root - the linked folder of the app's project
     * @param appDir - the app folder relative to it
     */
    constructor(
        public readonly projectId: string,
        private readonly root: string,
        private readonly appDir: string
    ) {}

    /** Reads the app folder again, so a just installed or changed app starts as it is now. */
    public async devStack(policy: CommandPolicy): Promise<StackConfig> {
        const stack = await LinkedAppStack.inspect(this.root, this.appDir);
        if (stack === null) {
            throw new AgentError("not-configured", "The app folder is missing", "folder-missing");
        }
        return stack.toStackConfig(policy);
    }
}
