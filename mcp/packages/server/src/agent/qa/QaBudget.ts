import type { QaSettings } from "./QaConfig";

/** Limit a run stopped at. */
export type QaLimit = "screens" | "turns" | "time";

/**
 * Hard limits of one QA run, enforced in code whatever Claude or the client asks for: Claude turns
 * of the whole run and wall-clock time (rounds per screen and screens per run are capped by the
 * settings schema and applied by the callers).
 */
export class QaBudget {
    private turnsUsed = 0;
    private readonly deadline: number;
    /** the first limit the run hit, if any */
    public hit: QaLimit | null = null;

    constructor(
        private readonly settings: Pick<QaSettings, "maxClaudeTurns" | "maxMinutes">,
        private readonly now: () => number = Date.now
    ) {
        this.deadline = now() + settings.maxMinutes * 60_000;
    }

    /** Whether the run still has time; records the `time` limit when not. */
    public hasTime(): boolean {
        if (this.now() < this.deadline) {
            return true;
        }
        this.hit ??= "time";
        return false;
    }

    /**
     * Takes one Claude turn from the budget.
     *
     * @returns false (and records the limit) when no turn or no time is left
     */
    public takeTurn(): boolean {
        if (!this.hasTime()) {
            return false;
        }
        if (this.turnsUsed >= this.settings.maxClaudeTurns) {
            this.hit ??= "turns";
            return false;
        }
        this.turnsUsed++;
        return true;
    }

    /** Records that screens were left out for the `screens` limit. */
    public screensCut(): void {
        this.hit ??= "screens";
    }

    public get turns(): number {
        return this.turnsUsed;
    }
}
