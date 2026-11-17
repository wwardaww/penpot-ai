import { randomUUID } from "crypto";
import type { PermissionRequestMessage, PermissionRisk } from "@penpot/mcp-common";

/** Question put to the user before Claude may do something. */
export interface PermissionPrompt {
    title: string;
    description: string;
    risk: PermissionRisk;
}

/** Answer of the user to a {@link PermissionPrompt}. */
export interface PermissionAnswer {
    allow: boolean;
    remember: boolean;
}

/**
 * Asker of permission questions.
 */
export interface PermissionAsker {
    ask(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
}

/**
 * Broker of permission questions between Claude runs and one browser client.
 *
 * Sends `permission.request` messages and matches `permission.respond` messages to them. A question
 * that is not answered in time, whose run is aborted or whose client goes away counts as denied.
 */
export class PermissionBroker implements PermissionAsker {
    private static readonly DENIED: PermissionAnswer = { allow: false, remember: false };
    private readonly pending = new Map<string, (answer: PermissionAnswer) => void>();

    /**
     * @param send - sends a message to the client
     * @param timeoutMs - time after which an unanswered question counts as denied
     */
    constructor(
        private readonly send: (message: PermissionRequestMessage) => void,
        private readonly timeoutMs: number = 5 * 60_000
    ) {}

    public ask(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer> {
        if (signal.aborted) {
            return Promise.resolve(PermissionBroker.DENIED);
        }
        const requestId = randomUUID();
        return new Promise<PermissionAnswer>((resolve) => {
            const finish = (answer: PermissionAnswer) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.pending.delete(requestId);
                resolve(answer);
            };
            const onAbort = () => finish(PermissionBroker.DENIED);
            const timer = setTimeout(onAbort, this.timeoutMs);
            signal.addEventListener("abort", onAbort, { once: true });
            this.pending.set(requestId, finish);
            this.send({ type: "permission.request", requestId, ...prompt });
        });
    }

    /**
     * Applies the client's answer to a question.
     *
     * @returns false if no question with this id is pending
     */
    public respond(requestId: string, allow: boolean, remember: boolean): boolean {
        const finish = this.pending.get(requestId);
        if (!finish) {
            return false;
        }
        finish({ allow, remember: allow && remember });
        return true;
    }

    /** Denies every pending question (client disconnected). */
    public denyAll(): void {
        for (const finish of [...this.pending.values()]) {
            finish(PermissionBroker.DENIED);
        }
    }
}
