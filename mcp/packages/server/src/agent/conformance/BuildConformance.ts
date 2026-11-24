import { z } from "zod";
import type { WorkflowContext } from "@penpot/mcp-common";
import { TokenManifest } from "../tokens/TokenManifest";
import { AppSources } from "./AppSources";
import { type BuiltScreen, type CheckResult, ConformanceChecker, type ComponentMapping } from "./ConformanceChecker";
import { type ConformanceReport, ConformanceReports, type ConformanceSummary, type Finding } from "./ConformanceReport";
import { ContractPrompt, type PromptScreen } from "./ContractPrompt";
import { type DesignContract, DesignContractReader } from "./DesignContract";
import { type MotionLibraryId } from "./MotionCode";
import { MotionFile } from "./MotionFile";

/** What a build touched; null boards = everything (full build). */
export interface ConformanceScope {
    /** boards whose screens were built or updated */
    boards: ReadonlySet<string> | null;
    /** files changed by the build */
    files: ReadonlySet<string>;
    /** prototype flows changed: every flow finding counts */
    flows: boolean;
}

/** Components a build turn reports (`components` of its JSON reply). */
export const ComponentsReplySchema = z.object({
    components: z
        .array(z.object({ design: z.string().max(300), name: z.string().max(120), file: z.string().max(300) }))
        .max(200)
        .default([]),
});

/**
 * Conformance of one build: reads the design contract, gives the prompts their lines, writes the
 * motion file, checks the code and writes the report. Reading and checking never fail a build.
 */
export class BuildConformance {
    private static readonly COMPONENTS_FILE = "components.json";
    /** findings one fix turn gets at most */
    private static readonly MAX_FIX = 40;

    private readonly reports: ConformanceReports;
    private contract: DesignContract | null = null;
    private prompt: ContractPrompt | null = null;
    private motion: MotionFile | null = null;
    private library: MotionLibraryId = "css";
    private components: Record<string, ComponentMapping> = {};
    private result: CheckResult | null = null;
    private firstScoped: string[] | null = null;
    private attempts = 0;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly log: (text: string) => void
    ) {
        this.reports = new ConformanceReports(ctx.workspace);
    }

    /**
     * Reads the contract of the design for a build.
     *
     * @param screens - screens of the plan that are not removed
     * @param library - animation library of the stack
     */
    public async begin(screens: PromptScreen[], library: MotionLibraryId): Promise<void> {
        this.library = library;
        this.contract = await new DesignContractReader(this.ctx).read();
        this.prompt = new ContractPrompt(this.contract, screens);
        for (const { part, reason } of this.contract.unread) {
            this.log(`Conformance: the ${part} of the design could not be read: ${reason}`);
        }
        this.components = await this.readComponents();
    }

    /**
     * Writes the motion file (the app must exist) with the library of the final stack.
     *
     * @param library - animation library
     */
    public async writeMotion(library: MotionLibraryId): Promise<void> {
        this.library = library;
        if (this.contract === null || this.contract.unread.some((entry) => entry.part === "animations")) {
            return;
        }
        this.motion = await MotionFile.plan(this.ctx.workspace, library, this.contract.animations);
        await this.motion.write();
    }

    /** Prompt lines for the whole app. */
    public appLines(): string[] {
        return this.prompt?.appLines(this.library, this.motion) ?? [];
    }

    /** Prompt lines for one screen. */
    public screenLines(boardId: string): string[] {
        return this.prompt?.screenLines(boardId, this.motion) ?? [];
    }

    /** Navigation lines of one screen, null when the prototype is not known. */
    public navigationLines(boardId: string): string[] | null {
        return this.prompt?.navigationLines(boardId) ?? null;
    }

    /**
     * Keeps the code components a turn reports.
     *
     * @param components - reported components, files relative to the app folder
     */
    public async addComponents(components: ({ design: string } & ComponentMapping)[]): Promise<void> {
        const known = components.filter(({ name }) => /^[A-Za-z_$][\w$.]*$/.test(name));
        if (known.length === 0) {
            return;
        }
        for (const { design, name, file } of known) {
            this.components[design] = { name, file };
        }
        await this.ctx.workspace.writeJson(BuildConformance.COMPONENTS_FILE, {
            schemaVersion: 1,
            components: this.components,
        });
    }

    /**
     * Checks the code.
     *
     * @param screens - screens of the app with their files
     * @param scope - what the build touched
     * @returns the findings to fix (in scope), or null when the check could not run
     */
    public async check(screens: BuiltScreen[], scope: ConformanceScope): Promise<Finding[] | null> {
        if (this.contract === null) {
            return null;
        }
        // an edited motion file goes back to the generated one before the check
        await this.motion?.write();
        const appDir = this.ctx.workspace.appSrcDir;
        const checker = new ConformanceChecker(await AppSources.load(appDir), {
            contract: this.contract,
            screens,
            components: this.components,
            motion: this.motion,
            theme: await TokenManifest.read(this.ctx.workspace),
            dependencies: await MotionFile.dependencies(appDir),
        });
        this.result = checker.check();
        const scoped = this.result.findings.filter((finding) => this.inScope(finding, scope));
        this.firstScoped ??= scoped.map((finding) => finding.id);
        return scoped;
    }

    /**
     * Gets the prompt of a fix turn.
     *
     * @param findings - findings in scope
     */
    public fixPrompt(findings: Finding[]): string {
        this.attempts++;
        return ContractPrompt.fix(findings.slice(0, BuildConformance.MAX_FIX));
    }

    /**
     * Boards whose files a fix may change besides the touched ones: a link between screens may
     * start on a screen the build did not touch.
     *
     * @param findings - findings in scope
     */
    public static boardsOf(findings: Finding[]): Set<string> {
        return new Set(findings.flatMap((finding) => (finding.boardId === null ? [] : [finding.boardId])));
    }

    /**
     * Writes the report.
     *
     * @param scope - what the build touched
     * @param mode - build mode
     * @param build - number of the recorded build
     * @returns summary for the client
     */
    public async finish(
        scope: ConformanceScope,
        mode: ConformanceReport["mode"],
        build: number | null
    ): Promise<ConformanceSummary> {
        const result = this.result;
        if (result === null) {
            return {
                status: "unchecked",
                fixed: 0,
                left: 0,
                elsewhere: 0,
                items: [],
                skipped: [],
            };
        }
        const inScope = (finding: Finding) => this.inScope(finding, scope);
        const findings = [
            ...result.findings.filter(inScope),
            ...result.findings.filter((finding) => !inScope(finding)),
        ];
        const ids = new Set(findings.map((finding) => finding.id));
        const previous = await this.reports.read();
        const before =
            previous !== null && previous.fileId === this.ctx.context.fileId
                ? previous.findings.map((finding) => finding.id)
                : [];
        const states = Object.values(result.checks).map((check) => check.state);
        const report: ConformanceReport = {
            schemaVersion: 1,
            at: new Date().toISOString(),
            fileId: this.ctx.context.fileId,
            build,
            mode,
            status:
                findings.length > 0 ? "findings" : states.every((state) => state === "skipped") ? "unchecked" : "clean",
            checks: result.checks,
            findings: findings.slice(0, ConformanceReports.MAX_FINDINGS),
            more: Math.max(0, findings.length - ConformanceReports.MAX_FINDINGS),
            fixed: (this.firstScoped ?? []).filter((id) => !ids.has(id)).length,
            attempts: this.attempts,
            touched: scope.boards === null ? [] : [...scope.boards],
            diff: {
                added: [...ids].filter((id) => !before.includes(id)),
                resolved: before.filter((id) => !ids.has(id)),
            },
        };
        await this.reports.write(report);
        return ConformanceReports.summary(report, inScope);
    }

    private inScope(finding: Finding, scope: ConformanceScope): boolean {
        const boards = scope.boards;
        if (boards === null || (finding.check === "flows" && scope.flows)) {
            return true;
        }
        switch (finding.code) {
            case "start-screen":
            case "motion-not-loaded":
            case "motion-library-missing":
                return true;
            case "component-missing": {
                const component = this.contract?.components.find((c) => c.design === finding.params.component);
                return Object.keys(component?.boards ?? {}).some((boardId) => boards.has(boardId));
            }
            default:
                return finding.file !== null
                    ? scope.files.has(finding.file)
                    : finding.boardId !== null && boards.has(finding.boardId);
        }
    }

    private async readComponents(): Promise<Record<string, ComponentMapping>> {
        const raw = await this.ctx.workspace
            .readJson<{ components?: Record<string, Partial<ComponentMapping>> } | null>(
                BuildConformance.COMPONENTS_FILE,
                null
            )
            .catch(() => null);
        const components: Record<string, ComponentMapping> = {};
        for (const [design, entry] of Object.entries(raw?.components ?? {})) {
            if (typeof entry?.name === "string" && typeof entry.file === "string") {
                components[design] = { name: entry.name, file: entry.file };
            }
        }
        return components;
    }
}
