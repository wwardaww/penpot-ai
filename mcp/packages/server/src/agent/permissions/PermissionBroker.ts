import { randomUUID } from "crypto";
import type {
    PermissionAnsweredMessage,
    PermissionClosedMessage,
    PermissionRequestMessage,
    PermissionRisk,
} from "@penpot/mcp-common";
import { PermissionModeState } from "./PermissionModeState";

/** Question put to the user before Claude may do something. */
export interface PermissionPrompt {
    title: string;
    description: string;
    risk: PermissionRisk;
    /** why the mode `auto` refuses this instead of approving it, for Claude; null approves */
    autoRefusal?: string | null;
}

/** Answer of the user to a {@link PermissionPrompt}. */
export interface PermissionAnswer {
    allow: boolean;
    remember: boolean;
    /** why it was refused, for Claude, when not the user decided */
    reason?: string;
}

/**
 * Asker of permission questions.
 */
export interface PermissionAsker {
    /** whether questions are answered without the user (mode `auto`) */
    readonly unattended?: boolean;
    ask(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
}

/**
 * Broker of permission questions between Claude runs and one browser client.
 *
 * Sends `permission.request` messages and matches `permission.respond` messages to them. A question
 * that is not answered in time, whose run is aborted or whose client goes away counts as denied.
 *
 * In the permission mode `auto` the broker answers itself: it approves a question unless its prompt
 * says why not. The question and its answer are sent all the same, so that both stay visible.
 */
export class PermissionBroker implements PermissionAsker {
    private static readonly DENIED: PermissionAnswer = { allow: false, remember: false };
    private readonly pending = new Map<
        string,
        { prompt: PermissionPrompt; finish: (answer: PermissionAnswer) => void }
    >();

    /**
     * @param send - sends a message to the client
     * @param timeoutMs - time after which an unanswered question counts as denied
     * @param mode - the permission mode in force
     */
    constructor(
        private readonly send: (
            message: PermissionRequestMessage | PermissionClosedMessage | PermissionAnsweredMessage
        ) => void,
        private readonly timeoutMs: number = 5 * 60_000,
        private readonly mode: PermissionModeState = new PermissionModeState()
    ) {}

    public get unattended(): boolean {
        return this.mode.unattended;
    }

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
            const onAbort = () => {
                finish(PermissionBroker.DENIED);
                // the card must not stay open: an answer would reach nobody
                this.send({ type: "permission.closed", requestId });
            };
            const timer = setTimeout(onAbort, this.timeoutMs);
            signal.addEventListener("abort", onAbort, { once: true });
            this.pending.set(requestId, { prompt, finish });
            const { title, description, risk } = prompt;
            this.send({ type: "permission.request", requestId, title, description, risk });
            this.answerUnattended();
        });
    }

    /** Answers every pending question when the mode is `auto`; call it when the mode changed. */
    public answerUnattended(): void {
        if (!this.mode.unattended) {
            return;
        }
        for (const [requestId, { prompt, finish }] of [...this.pending]) {
            const reason = prompt.autoRefusal ?? undefined;
            const allow = reason === undefined;
            finish({ allow, remember: false, reason });
            this.send({ type: "permission.answered", requestId, allow, auto: true });
        }
    }

    /**
     * Applies the client's answer to a question.
     *
     * @returns false if no question with this id is pending
     */
    public respond(requestId: string, allow: boolean, remember: boolean): boolean {
        const question = this.pending.get(requestId);
        if (!question) {
            return false;
        }
        question.finish({ allow, remember: allow && remember });
        return true;
    }

    /** Denies every pending question (client disconnected). */
    public denyAll(): void {
        for (const { finish } of [...this.pending.values()]) {
            finish(PermissionBroker.DENIED);
        }
    }
}
