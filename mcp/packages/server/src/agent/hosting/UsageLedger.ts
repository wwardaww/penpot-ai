import { existsSync } from "fs";
import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "../../logger";

/** Token usage of one Anthropic API request. */
export interface ApiUsage {
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
}

/** One line of the usage ledger. */
export interface UsageRecord extends ApiUsage {
    at: string;
    profileId: string;
    teamId?: string;
}

/**
 * Usage accounting of server mode: one JSON line per Anthropic API request in
 * `<dir>/<yyyy-mm>.jsonl` (UTC month), plus running token totals per team for the monthly
 * budget.
 */
export class UsageLedger {
    private readonly logger = createLogger("UsageLedger");
    /** token totals per month and team, loaded from the month's file on first use */
    private readonly totals = new Map<string, Promise<Map<string, number>>>();
    private writes: Promise<void> = Promise.resolve();

    /**
     * @param dir - folder of the monthly files
     * @param now - clock
     */
    constructor(
        private readonly dir: string,
        private readonly now: () => Date = () => new Date()
    ) {}

    /**
     * Records the usage of one request.
     *
     * @param who - the user and team
     * @param usage - the request's usage
     */
    public async record(who: { profileId: string; teamId?: string }, usage: ApiUsage): Promise<void> {
        const at = this.now();
        const month = UsageLedger.month(at);
        const totals = await this.monthTotals(month);
        if (who.teamId) {
            totals.set(who.teamId, (totals.get(who.teamId) ?? 0) + UsageLedger.tokens(usage));
        }
        const record: UsageRecord = { at: at.toISOString(), profileId: who.profileId, teamId: who.teamId, ...usage };
        const write = this.writes.then(async () => {
            await mkdir(this.dir, { recursive: true });
            await appendFile(join(this.dir, `${month}.jsonl`), JSON.stringify(record) + "\n", { mode: 0o600 });
        });
        this.writes = write.catch((error: unknown) => this.logger.warn("Could not write usage: %s", String(error)));
        await this.writes;
    }

    /**
     * Tokens (input + output, cache included) a team used in the current month.
     *
     * @param teamId - the team
     */
    public async teamTokens(teamId: string): Promise<number> {
        const totals = await this.monthTotals(UsageLedger.month(this.now()));
        return totals.get(teamId) ?? 0;
    }

    /** Summary of the current month per team, for the admin page. */
    public async monthSummary(): Promise<{ month: string; teams: Record<string, number> }> {
        const month = UsageLedger.month(this.now());
        const totals = await this.monthTotals(month);
        return { month, teams: Object.fromEntries(totals) };
    }

    private monthTotals(month: string): Promise<Map<string, number>> {
        let totals = this.totals.get(month);
        if (!totals) {
            totals = this.load(month);
            this.totals.set(month, totals);
        }
        return totals;
    }

    private async load(month: string): Promise<Map<string, number>> {
        const totals = new Map<string, number>();
        const path = join(this.dir, `${month}.jsonl`);
        if (!existsSync(path)) {
            return totals;
        }
        for (const line of (await readFile(path, "utf8")).split("\n")) {
            try {
                const record = JSON.parse(line) as UsageRecord;
                if (record.teamId) {
                    totals.set(record.teamId, (totals.get(record.teamId) ?? 0) + UsageLedger.tokens(record));
                }
            } catch {
                // a torn last line
            }
        }
        return totals;
    }

    private static tokens(usage: ApiUsage): number {
        return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    }

    private static month(date: Date): string {
        return date.toISOString().slice(0, 7);
    }
}
