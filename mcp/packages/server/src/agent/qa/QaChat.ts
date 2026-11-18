import { AppSourceGit } from "../build/AppSourceGit";
import { PngImages } from "./PngImages";
import { QaConfig, type QaSettings } from "./QaConfig";
import { QaGit } from "./QaGit";
import { QaRun, type QaScreenReport, type VisualQaServices } from "./QaRun";
import { QaError, type QaEnv, type QaShot, VisualQa } from "./VisualQa";

/** Request of the `penforge_visual_qa` tool. */
export interface QaChatRequest {
    fileId: string;
    boardIds?: string[];
    commit?: boolean;
    /** MCP plugin session of the calling tab (added to every Penpot tool call of a chat turn) */
    sessionId?: string;
}

/** Content block of the tool's answer. */
export type QaChatContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Fix round of the chat in one project: from its first check to its commit. */
interface ChatRound {
    /** `app-src/` snapshot at the first check (tree hash) */
    baseline: string;
    /** files that had uncommitted changes at the first check; never committed by the QA */
    foreign: Set<string>;
    /** checks made in this round */
    checks: number;
    startedAt: number;
}

/**
 * Visual QA for the AI chat (`penforge_visual_qa` MCP tool): Claude, in a chat turn, checks the
 * running app against the design, sees the worst screen's images, fixes the code itself with its
 * file tools, checks again, and finally asks Penforge to commit (`commit: true`).
 *
 * The tool runs inside the MCP server, outside any client session, so it serves only the browser
 * tab whose Penpot MCP session made the call, and only for that tab's file. Limits in code: at
 * most `maxIterations` re-checks per round (a round ends with a commit or after `maxMinutes`),
 * and the commit holds only files changed since the round's first check.
 */
export class QaChat {
    /** failing screens whose images go back to Claude */
    private static readonly IMAGE_SCREENS = 1;
    /** open rounds by project root */
    private static readonly rounds = new Map<string, ChatRound>();

    constructor(
        private readonly services: VisualQaServices,
        private readonly now: () => number = Date.now
    ) {}

    public async handle(request: QaChatRequest): Promise<QaChatContent[]> {
        if (!request.sessionId) {
            throw new Error("penforge_visual_qa needs the sessionId of the user's tab.");
        }
        const client = await this.services.clientForMcpSession(request.sessionId);
        if (!client || client.context.fileId !== request.fileId) {
            throw new Error("No Penforge tab with this session has that file open.");
        }
        const { workspace } = client;
        const settings = await new QaConfig(workspace).read();
        const round = this.round(workspace.root, settings);
        if (request.commit) {
            return [QaChat.text(await this.commit(workspace.appSrcDir, workspace.root, round))];
        }
        if (!client.tools) {
            throw new Error("Penpot tools are not available in this daemon.");
        }
        if (round && round.checks > settings.maxIterations) {
            return [
                QaChat.text({
                    error: "limit",
                    message:
                        `Stopped at the limit of ${settings.maxIterations} re-checks. Commit the changes ` +
                        "(commit: true) or tell the user what is still different.",
                }),
            ];
        }
        const env: QaEnv = { workspace, tools: client.tools, fileId: request.fileId, progress: () => {} };
        try {
            const { screens, skipped } = await VisualQa.screens(env, request.boardIds ?? []);
            const picked = screens.slice(0, settings.maxScreens);
            if (picked.length === 0) {
                throw new QaError("None of the screens can be opened in the app.", "no-screens");
            }
            const checks = await this.startRound(workspace.appSrcDir, workspace.root, round);
            const run = await QaRun.start(env, this.services, settings);
            try {
                const shots: QaShot[] = [];
                for (const screen of picked) {
                    shots.push(await run.qa.check(screen));
                }
                const reports: QaScreenReport[] = [];
                for (const shot of shots) {
                    reports.push(await run.screenReport(shot, { images: false, developer: true }));
                }
                const summary = {
                    runName: run.qa.runName,
                    threshold: settings.threshold,
                    score: QaRun.averageScore(shots),
                    passed: shots.every((shot) => shot.passed),
                    recheck: checks - 1,
                    maxRechecks: settings.maxIterations,
                    screens: reports.map((report, index) => ({
                        ...report,
                        files: shots[index].screen.files,
                        regions: shots[index].regions,
                    })),
                    skippedScreens: [
                        ...QaRun.skippedReport(skipped),
                        ...screens.slice(settings.maxScreens).map((s) => ({
                            boardId: s.boardId,
                            name: s.name,
                            route: s.route,
                            reason: "limit",
                        })),
                    ],
                };
                await run.qa.writeReport({ ...summary, source: "chat", createdAt: new Date().toISOString() });
                await VisualQa.prune(workspace);
                return [
                    QaChat.text(summary),
                    ...(await QaChat.images(shots)),
                    QaChat.text(QaChat.advice(summary.passed, settings)),
                ];
            } finally {
                await run.close();
            }
        } catch (error) {
            if (error instanceof QaError) {
                return [QaChat.text({ error: error.code, message: error.message })];
            }
            throw error;
        }
    }

    /** The open round of a project, or undefined (rounds older than `maxMinutes` are dropped). */
    private round(root: string, settings: QaSettings): ChatRound | undefined {
        const round = QaChat.rounds.get(root);
        if (round && this.now() - round.startedAt > settings.maxMinutes * 60_000) {
            QaChat.rounds.delete(root);
            return undefined;
        }
        return round;
    }

    /** Counts a check in the project's round, opening it at the first check; returns the count. */
    private async startRound(appSrcDir: string, root: string, round: ChatRound | undefined): Promise<number> {
        if (round) {
            return ++round.checks;
        }
        const foreign = new Set(await new QaGit(appSrcDir).dirtyFiles());
        const baseline = await new AppSourceGit(appSrcDir).snapshot();
        QaChat.rounds.set(root, { baseline, foreign, checks: 1, startedAt: this.now() });
        return 1;
    }

    /** Commits the files changed since the round's first check, except the user's own changes. */
    private async commit(appSrcDir: string, root: string, round: ChatRound | undefined): Promise<unknown> {
        if (!round) {
            return { commit: null, message: "Nothing to commit: run a check first, then fix, then commit." };
        }
        const git = new AppSourceGit(appSrcDir);
        const changed = await git.changedFiles(round.baseline, await git.snapshot());
        const files = changed.filter((file) => !round.foreign.has(file));
        const commit = await new QaGit(appSrcDir).commitFiles(files, "penforge(qa): match the app to the design");
        QaChat.rounds.delete(root);
        return { commit, files, message: commit ? "Code changes committed." : "Nothing to commit." };
    }

    private static async images(shots: QaShot[]): Promise<QaChatContent[]> {
        const worst = shots
            .filter((shot) => !shot.passed)
            .sort((a, b) => a.score - b.score)
            .slice(0, QaChat.IMAGE_SCREENS);
        const content: QaChatContent[] = [];
        for (const shot of worst) {
            content.push(
                QaChat.text(
                    `Images of "${shot.screen.name}" (score ${shot.score}): 1. design, 2. app now, ` +
                        "3. differences (red = differs, grey = design). Large images are scaled down."
                )
            );
            for (const png of [shot.design, shot.app, shot.diff]) {
                const image = await PngImages.forClaude(png);
                content.push({ type: "image", data: image.base64, mimeType: image.mime });
            }
        }
        return content;
    }

    private static advice(passed: boolean, settings: QaSettings): string {
        return passed
            ? "Every screen matches the design. Tell the user; no code change is needed."
            : "Screens below the threshold differ from the design. To fix them, change only the listed " +
                  "files in app-src/ (read exact values with get_node_properties / generate_code_hints; " +
                  "never change the design), then call penforge_visual_qa again with their boardIds to " +
                  `re-check. At most ${settings.maxIterations} re-checks; undo a change that does not raise ` +
                  "the score. When done, call it once with commit: true to save the code, and tell the user " +
                  "the scores before and after.";
    }

    private static text(value: unknown): QaChatContent {
        return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
    }

    /** Forgets every open round (tests). */
    public static reset(): void {
        QaChat.rounds.clear();
    }
}
