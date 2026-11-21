import type { WorkflowToolsApi, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { BindingStore, type DesignSystemBinding } from "./Binding";
import { ConformanceChecker } from "./ConformanceChecker";
import { ConformanceScripts, type FixReport, type LinkReport, type ScanScope } from "./ConformanceScripts";
import { MissingItems } from "./MissingItems";
import type { CheckReport, FixOp, MissingItem, ScanResult, SystemCatalog } from "./types";

/** What one conformance pass should do. */
export interface ConformanceOptions {
    mode: "check" | "redesign";
    /** apply the planned fixes (else only report them) */
    fix: boolean;
    scope: ScanScope;
}

/** Outcome of one conformance pass. */
export interface ConformanceOutcome {
    catalog: SystemCatalog;
    /** the link step ran because the open file was not linked yet */
    link: LinkReport | null;
    /** fixes that were applied (or planned when `fix` was false), findings, new missing items */
    report: CheckReport;
    applied: FixReport | null;
    /** open missing items after the pass (the AI's and the check's) */
    openMissing: MissingItem[];
}

/**
 * One pass of the design system check (W30) on the open file: make sure the linked design system
 * library is linked to this file too, read what it offers, scan the layers, plan fixes, apply
 * them in one undo step, and record the project's own components the system lacks.
 */
export class DesignSystemConformance {
    private readonly scripts: ConformanceScripts;

    /**
     * @param tools - Penpot tools of the tab
     * @param workspace - the project's workspace
     * @param fileId - the open file
     */
    constructor(
        tools: WorkflowToolsApi,
        private readonly workspace: WorkflowWorkspaceApi,
        private readonly fileId: string
    ) {
        this.scripts = new ConformanceScripts(tools);
    }

    /** The project's binding, or null. */
    public static binding(workspace: WorkflowWorkspaceApi): Promise<DesignSystemBinding | null> {
        return new BindingStore(workspace).read().catch(() => null);
    }

    /**
     * Reads the system's catalog, linking the library to the open file first when needed (a new
     * file of a project that already uses a design system).
     */
    public async catalog(binding: DesignSystemBinding): Promise<{ catalog: SystemCatalog; link: LinkReport | null }> {
        let catalog = await this.scripts.run<SystemCatalog>(ConformanceScripts.catalogScript(binding.fileId));
        let link: LinkReport | null = null;
        if (!catalog.linked) {
            link = await this.scripts.run<LinkReport>(ConformanceScripts.linkScript(binding.fileId));
            catalog = await this.scripts.run<SystemCatalog>(ConformanceScripts.catalogScript(binding.fileId));
        }
        if (catalog.linked && !binding.linkedFiles.includes(this.fileId)) {
            binding.linkedFiles = [...binding.linkedFiles, this.fileId];
            await new BindingStore(this.workspace).write(binding);
        }
        return { catalog, link };
    }

    /** Reads the layers of a scope. */
    public scan(scope: ScanScope): Promise<ScanResult> {
        return this.scripts.run<ScanResult>(ConformanceScripts.scanScript(scope));
    }

    /** Applies fix ops (in run order) in one undo step. */
    public async apply(libraryId: string, ops: FixOp[], pageOf: Record<string, string>): Promise<FixReport> {
        if (ops.length === 0) {
            return { applied: 0, failed: [] };
        }
        return this.scripts.run<FixReport>(ConformanceScripts.fixScript(libraryId, ops, pageOf));
    }

    /** Runs a full pass. */
    public async run(binding: DesignSystemBinding, options: ConformanceOptions): Promise<ConformanceOutcome> {
        const { catalog, link } = await this.catalog(binding);
        const missing = new MissingItems(this.workspace, binding.fileId);
        if (!catalog.linked) {
            return {
                catalog,
                link,
                report: { fixes: [], findings: [], missing: [], scanned: 0, truncated: false },
                applied: null,
                openMissing: await missing.open(),
            };
        }
        const scan = await this.scan(options.scope);
        const checker = new ConformanceChecker(catalog, {
            mode: options.mode,
            fileId: this.fileId,
            keptComponentIds: await missing.keptComponentIds(),
        });
        const report = checker.check(scan.layers, scan.truncated);
        let applied: FixReport | null = null;
        if (options.fix && report.fixes.length > 0) {
            const pageOf = Object.fromEntries(scan.layers.map((layer) => [layer.id, layer.pageId]));
            applied = await this.apply(catalog.libraryId, ConformanceChecker.ops(report.fixes), pageOf);
            const failed = new Set(applied.failed.map((failure) => failure.layerId));
            report.fixes = report.fixes.filter((fix) => !failed.has(fix.layerId));
        }
        if (report.missing.length > 0) {
            await missing.merge(report.missing);
        }
        return { catalog, link, report, applied, openMissing: await missing.open() };
    }
}
