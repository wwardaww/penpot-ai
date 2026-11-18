import { AgentError } from "../AgentClient";
import type { ServerLimits } from "./ServerStore";
import type { UsageLedger } from "./UsageLedger";

/**
 * Error of a Claude turn refused by a limit; the client gets code `rate-limited`.
 */
export class RateLimitedError extends AgentError {
    /**
     * @param message - English text for the user
     * @param retryAfterS - seconds until a new turn may start
     */
    constructor(
        message: string,
        public readonly retryAfterS: number
    ) {
        super("rate-limited", message);
        this.name = "RateLimitedError";
    }
}

/** A started turn; {@link release} it when the turn ends. */
export class TurnPermit {
    private released = false;

    constructor(private readonly onRelease: () => void) {}

    /** Ends the turn (idempotent). */
    public release(): void {
        if (!this.released) {
            this.released = true;
            this.onRelease();
        }
    }
}

/**
 * Per-user limits of Claude turns in server mode: turns at the same time, per minute and per
 * UTC day, plus a monthly token budget per team (from the {@link UsageLedger}).
 */
export class TurnLimiter {
    private readonly active = new Map<string, number>();
    private readonly recent = new Map<string, number[]>();
    private readonly daily = new Map<string, { day: string; count: number }>();

    /**
     * @param limits - gets the current limits (admins may change them at any time)
     * @param ledger - token usage per team
     * @param now - clock in milliseconds
     */
    constructor(
        private readonly limits: () => Promise<ServerLimits>,
        private readonly ledger: UsageLedger,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Starts a turn for a user, or refuses it.
     *
     * @param who - the user and the team of the project
     * @throws RateLimitedError when a limit is reached
     */
    public async acquire(who: { profileId: string; teamId?: string }): Promise<TurnPermit> {
        const limits = await this.limits();
        if (limits.monthlyTokensPerTeam > 0 && who.teamId) {
            const used = await this.ledger.teamTokens(who.teamId);
            if (used >= limits.monthlyTokensPerTeam) {
                throw new RateLimitedError(
                    "Your team has used its AI budget for this month. Ask your admin to raise it.",
                    TurnLimiter.secondsToNextMonth(this.now())
                );
            }
        }
        // checks and counting below run without awaiting, so two requests cannot both pass
        const now = this.now();
        const id = who.profileId;
        const active = this.active.get(id) ?? 0;
        if (limits.concurrentTurnsPerUser > 0 && active >= limits.concurrentTurnsPerUser) {
            throw new RateLimitedError("Wait for your running AI requests to finish.", 5);
        }
        const window = (this.recent.get(id) ?? []).filter((at) => at > now - 60_000);
        if (limits.turnsPerMinutePerUser > 0 && window.length >= limits.turnsPerMinutePerUser) {
            throw new RateLimitedError(
                "Too many AI requests in a minute. Try again shortly.",
                Math.max(1, Math.ceil((window[0] + 60_000 - now) / 1000))
            );
        }
        const day = new Date(now).toISOString().slice(0, 10);
        const daily = this.daily.get(id);
        const today = daily?.day === day ? daily.count : 0;
        if (limits.turnsPerDayPerUser > 0 && today >= limits.turnsPerDayPerUser) {
            throw new RateLimitedError(
                "You reached today's AI request limit.",
                Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now) / 1000)
            );
        }
        window.push(now);
        this.recent.set(id, window);
        this.daily.set(id, { day, count: today + 1 });
        this.active.set(id, active + 1);
        return new TurnPermit(() => {
            const count = (this.active.get(id) ?? 1) - 1;
            if (count > 0) {
                this.active.set(id, count);
            } else {
                this.active.delete(id);
            }
        });
    }

    private static secondsToNextMonth(now: number): number {
        const date = new Date(now);
        const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
        return Math.ceil((next - now) / 1000);
    }
}
