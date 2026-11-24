import type { TokenManifestData } from "../tokens/TokenManifest";
import { AppSources } from "./AppSources";
import { CodeNames } from "./CodeNames";
import type { CheckName, CheckState, Finding } from "./ConformanceReport";
import type { DesignContract, UsedComponent } from "./DesignContract";
import { DesignValueLint } from "./DesignValueLint";
import { MotionFile } from "./MotionFile";
import { type PrototypeLink, PrototypeLinks } from "./PrototypeLinks";

/** Screen of the built app. */
export interface BuiltScreen {
    boardId: string;
    name: string;
    route: string;
    /** files of the screen, relative to the app folder */
    files: string[];
}

/** Code component of a design component, as the build reported it. */
export interface ComponentMapping {
    name: string;
    file: string;
}

/** What a check needs besides the sources. */
export interface CheckInput {
    contract: DesignContract;
    screens: BuiltScreen[];
    /** by design name (`Cards/Task card`) */
    components: Record<string, ComponentMapping>;
    motion: MotionFile | null;
    theme: TokenManifestData | null;
    /** dependency names of the app */
    dependencies: ReadonlySet<string>;
}

/** Result of a check. */
export interface CheckResult {
    checks: Record<CheckName, CheckState>;
    findings: Finding[];
}

/**
 * Checks the code of a built app against the design contract: routes and links of the prototype,
 * hard-coded design values, one code component per design component, and the generated motions in
 * use on their screens. Reads code only and runs nothing; a doubtful case counts as fine, so a
 * finding is worth a fix.
 */
export class ConformanceChecker {
    private readonly names = new Map<string, string>();

    /**
     * @param sources - the app's source files
     * @param input - contract and build facts
     */
    constructor(
        private readonly sources: AppSources,
        private readonly input: CheckInput
    ) {
        for (const board of input.contract.boards) {
            this.names.set(board.id, board.name);
        }
        for (const screen of input.screens) {
            this.names.set(screen.boardId, screen.name);
        }
    }

    /** Runs every check. */
    public check(): CheckResult {
        const flows = this.flows();
        const values = this.values();
        const components = this.components();
        const animations = this.animations();
        return {
            checks: {
                flows: flows.state,
                values: values.state,
                components: components.state,
                animations: animations.state,
            },
            findings: [...flows.findings, ...components.findings, ...animations.findings, ...values.findings],
        };
    }

    // flows -----------------------------------------------------------------------------------

    private flows(): { state: CheckState; findings: Finding[] } {
        const { contract, screens } = this.input;
        const skipped = this.unread("prototype");
        if (skipped !== null) {
            return { state: skipped, findings: [] };
        }
        const findings: Finding[] = [];
        for (const screen of screens) {
            if (!this.sources.hasRoute(screen.route)) {
                findings.push(
                    this.finding("route-missing", "flows", screen.boardId, screen.route, {
                        params: { screen: screen.name, route: screen.route },
                        text: `The app has no route ${screen.route} for the screen "${screen.name}"`,
                    })
                );
            }
        }
        findings.push(...this.extraRoutes());
        const start = contract.flows
            .map((flow) => screens.find((s) => s.boardId === flow.startingBoardId))
            .find(Boolean);
        if (start !== undefined && !this.sources.startsAt(start.route, CodeNames.variants(start.name))) {
            findings.push(
                this.finding("start-screen", "flows", null, start.route, {
                    params: { screen: start.name, route: start.route },
                    text: `The app must start on "${start.name}" (${start.route}), the start of the prototype flow`,
                })
            );
        }
        const links = this.uniqueLinks();
        for (const link of links) {
            const finding = this.link(link);
            if (finding !== null) {
                findings.push(finding);
            }
        }
        return { state: ConformanceChecker.state(findings, screens.length + links.length), findings };
    }

    private extraRoutes(): Finding[] {
        const planned = this.input.screens.map((screen) => AppSources.normalize(screen.route));
        const findings: Finding[] = [];
        const seen = new Set<string>();
        for (const { route, file } of this.sources.declaredRoutes()) {
            const known = planned.some(
                (plan) => plan === route || plan.startsWith(`${route}/`) || plan.endsWith(route)
            );
            if (route === "/" || route.includes("*") || known || seen.has(route)) {
                continue;
            }
            seen.add(route);
            findings.push(
                this.finding("route-extra", "flows", null, route, {
                    file,
                    params: { route, file },
                    text: `${file} declares the route ${route}, which no screen of the design has`,
                })
            );
        }
        return findings;
    }

    /** Links worth a check, one per source screen, target and action. */
    private uniqueLinks(): PrototypeLink[] {
        const seen = new Set<string>();
        return this.input.contract.links.filter((link) => {
            const key = `${link.from}>${link.to ?? link.url ?? ""}:${link.type}`;
            if (link.type === "close-overlay" || seen.has(key) || this.screensOf(link.from).length === 0) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    private link(link: PrototypeLink): Finding | null {
        const from = this.name(link.from);
        const texts = this.closureTexts(link.from);
        const matches = (pattern: RegExp) => texts.some((text) => pattern.test(text));
        const base = { source: link.sourceName, screen: from };
        switch (link.type) {
            case "navigate": {
                const target = this.input.screens.find((screen) => screen.boardId === link.to);
                // boards that are no screens, and a screen that scrolls to itself, need no route
                if (target === undefined || link.to === link.from) {
                    return null;
                }
                return this.leadsTo(target, matches)
                    ? null
                    : this.finding("link-missing", "flows", link.from, link.to ?? "", {
                          params: { ...base, target: target.name, route: target.route },
                          text: `"${link.sourceName}" on "${from}" must lead to "${target.name}" (${target.route}) on ${link.trigger}`,
                      });
            }
            case "previous-screen": {
                const back =
                    /\bnavigate\(\s*-1\s*\)|\bhistory\.(?:back|go)\(|\brouter\.(?:back|dismiss|go)\(|\bgoBack\(|\bcanGoBack\(|\$router\.(?:back|go)\(|\bnavigation\.pop\(|\blocation\.back\(/;
                return matches(back)
                    ? null
                    : this.finding("back-missing", "flows", link.from, "back", {
                          params: base,
                          text: `"${link.sourceName}" on "${from}" must go back to the previous screen`,
                      });
            }
            case "open-overlay":
            case "toggle-overlay": {
                const overlay = this.name(link.to ?? "");
                const target = this.input.screens.find((screen) => screen.boardId === link.to);
                const named = CodeNames.variants(overlay).some((name) => matches(CodeNames.word(name)));
                return named || (target !== undefined && this.leadsTo(target, matches))
                    ? null
                    : this.finding("overlay-missing", "flows", link.from, link.to ?? "", {
                          params: { ...base, target: overlay },
                          text: `"${link.sourceName}" on "${from}" must open "${overlay}" as an overlay (name its component after the board: ${CodeNames.component(overlay)})`,
                      });
            }
            case "open-url": {
                const url = link.url ?? "";
                return url.length === 0 || texts.some((text) => text.includes(url))
                    ? null
                    : this.finding("url-missing", "flows", link.from, url, {
                          params: { ...base, url },
                          text: `"${link.sourceName}" on "${from}" must open ${url}`,
                      });
            }
            default:
                return null;
        }
    }

    private leadsTo(target: BuiltScreen, matches: (pattern: RegExp) => boolean): boolean {
        return (
            matches(AppSources.quoted(target.route)) ||
            // a constant (`routes.addTask`) or a screen name (`navigate("AddTask")`)
            this.sources
                .constantsOf(target.route)
                .some((name) => matches(new RegExp(`(?:\\.|\\[["'])${CodeNames.escape(name)}\\b`))) ||
            CodeNames.variants(target.name).some((name) => matches(AppSources.quoted(name)))
        );
    }

    // values ----------------------------------------------------------------------------------

    private values(): { state: CheckState; findings: Finding[] } {
        const { theme, contract, motion } = this.input;
        if (theme === null || theme.tokens.size === 0) {
            return {
                state: { state: "skipped", reason: "The app has no theme with design tokens", checked: 0 },
                findings: [],
            };
        }
        const lint = new DesignValueLint(theme, contract.designSystem !== null);
        const owners = this.owners();
        const findings = lint
            .check(this.sources.files, new Set(motion === null ? [] : [motion.file]))
            .map((finding) => {
                const boardId = finding.file === null ? null : (owners.get(finding.file) ?? null);
                return { ...finding, boardId, screen: boardId === null ? null : this.name(boardId) };
            });
        return { state: ConformanceChecker.state(findings, this.sources.files.length), findings };
    }

    // components ------------------------------------------------------------------------------

    private components(): { state: CheckState; findings: Finding[] } {
        const skipped = this.unread("components");
        if (skipped !== null) {
            return { state: skipped, findings: [] };
        }
        const findings: Finding[] = [];
        const wanted = ConformanceChecker.required(this.input.contract);
        for (const component of wanted) {
            const name = this.codeName(component);
            if (name === null) {
                const suggested = CodeNames.component(component.name);
                findings.push(
                    this.finding("component-missing", "components", null, component.design, {
                        params: { component: component.design, name: suggested },
                        text: `The design component "${component.design}" has no code component; make one (${suggested}) and use it on every screen that has it`,
                    })
                );
                continue;
            }
            for (const boardId of Object.keys(component.boards)) {
                if (this.screensOf(boardId).length === 0) {
                    continue;
                }
                if (!this.closureTexts(boardId).some((text) => CodeNames.word(name).test(text))) {
                    findings.push(
                        this.finding("component-unused", "components", boardId, component.design, {
                            params: { component: component.design, name, screen: this.name(boardId) },
                            text: `"${this.name(boardId)}" uses the design component "${component.design}" but not its code component ${name}`,
                        })
                    );
                }
            }
        }
        return { state: ConformanceChecker.state(findings, wanted.length), findings };
    }

    /**
     * Gets the components the app needs as code components: those of the linked design system, and
     * local ones used more than once. Icons are left to the app's own icon approach.
     *
     * @param contract - the design contract
     */
    public static required(contract: DesignContract): UsedComponent[] {
        return contract.components.filter((component) => {
            const uses = Object.values(component.boards).reduce((sum, count) => sum + count, 0);
            const icon = /(^|[/\s_-])icons?([/\s_-]|$)/i.test(component.design);
            return !icon && (component.system || uses > 1);
        });
    }

    /** Name of a design component's code component: as reported by the build, else found by name. */
    private codeName(component: UsedComponent): string | null {
        const mapped = this.input.components[component.design];
        if (mapped !== undefined && CodeNames.word(mapped.name).test(this.sources.text(mapped.file))) {
            return mapped.name;
        }
        const names = CodeNames.componentNames(component.path, component.name);
        for (const file of this.sources.code()) {
            const base = file.file.slice(file.file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
            for (const name of names) {
                const declared = new RegExp(`\\b(?:function|const|class|let|var)\\s+${CodeNames.escape(name)}\\b`);
                if (declared.test(file.text) || base === name) {
                    return name;
                }
            }
        }
        return null;
    }

    // animations ------------------------------------------------------------------------------

    private animations(): { state: CheckState; findings: Finding[] } {
        const skipped = this.unread("animations");
        if (skipped !== null) {
            return { state: skipped, findings: [] };
        }
        const { motion, dependencies } = this.input;
        if (motion === null || motion.entries.length === 0) {
            return { state: { state: "ok", reason: null, checked: 0 }, findings: [] };
        }
        const findings: Finding[] = [];
        if (motion.packages.length > 0 && !motion.packages.some((name) => dependencies.has(name))) {
            findings.push(
                this.finding("motion-library-missing", "animations", null, motion.library, {
                    params: { library: motion.packages[0] },
                    text: `package.json lacks ${motion.packages[0]}, which the animations need; add it to the dependencies`,
                })
            );
        }
        let checked = 0;
        for (const entry of motion.entries) {
            // a board that is no screen (a component, an unused draft) has no place in the app
            if (this.screensOf(entry.layer.boardId).length === 0) {
                continue;
            }
            checked++;
            const usage = motion.usage(entry);
            const used = this.closureFiles(entry.layer.boardId).some(
                (file) => file.file !== motion.file && usage.test(file.text)
            );
            if (!used) {
                const references = motion.references(entry);
                findings.push(
                    this.finding("animation-missing", "animations", entry.layer.boardId, entry.layer.nodeId, {
                        params: {
                            layer: entry.layer.name,
                            screen: entry.layer.boardName,
                            motion: references.join(", "),
                        },
                        text: `The layer "${entry.layer.name}" on "${entry.layer.boardName}" is not animated; apply ${references.join(", ")} from ${motion.file}`,
                    })
                );
            }
        }
        if (checked > 0 && !this.isLoaded(motion)) {
            findings.push(
                this.finding("motion-not-loaded", "animations", null, motion.file, {
                    params: { file: motion.file },
                    text: `No file of the app imports ${motion.file}, so its animations do not run`,
                })
            );
        }
        return { state: ConformanceChecker.state(findings, checked), findings };
    }

    /** Tells whether some file imports (or links) the motion file. */
    private isLoaded(motion: MotionFile): boolean {
        const name = motion.file.slice(motion.file.lastIndexOf("/") + 1).replace(/\.(?:ts|js)$/, "");
        const pattern = new RegExp(`["'(][^"'()\\n]*penforge/${name.replace(".", "\\.")}(?:\\.js)?["')]`);
        return this.sources.files.some((file) => file.file !== motion.file && pattern.test(file.text));
    }

    // helpers ---------------------------------------------------------------------------------

    /** Screens a board is built in: itself, or for an overlay the screens that open it. */
    private screensOf(boardId: string, depth = 0): BuiltScreen[] {
        const own = this.input.screens.find((screen) => screen.boardId === boardId);
        if (own !== undefined) {
            return [own];
        }
        if (!this.input.contract.overlays.has(boardId) || depth > 3) {
            return [];
        }
        return PrototypeLinks.openers(this.input.contract.links, boardId).flatMap((opener) =>
            this.screensOf(opener, depth + 1)
        );
    }

    private closureFiles(boardId: string): { file: string; text: string }[] {
        const files = this.screensOf(boardId).flatMap((screen) => screen.files);
        return this.sources.closure([...new Set(files)]);
    }

    private closureTexts(boardId: string): string[] {
        return this.closureFiles(boardId).map((file) => file.text);
    }

    /** Board of every file that belongs to one screen only. */
    private owners(): Map<string, string> {
        const owners = new Map<string, string>();
        const shared = new Set<string>();
        for (const screen of this.input.screens) {
            for (const file of screen.files) {
                if (owners.has(file)) {
                    shared.add(file);
                }
                owners.set(file, screen.boardId);
            }
        }
        for (const file of shared) {
            owners.delete(file);
        }
        return owners;
    }

    private name(boardId: string): string {
        return this.names.get(boardId) ?? "";
    }

    private unread(part: string): CheckState | null {
        const unread = this.input.contract.unread.find((entry) => entry.part === part);
        return unread === undefined ? null : { state: "skipped", reason: unread.reason, checked: 0 };
    }

    private finding(
        code: Finding["code"],
        check: CheckName,
        boardId: string | null,
        target: string,
        rest: Pick<Finding, "params" | "text"> & { file?: string }
    ): Finding {
        return {
            id: `${code}:${boardId ?? "-"}:${target}`,
            code,
            check,
            boardId,
            screen: boardId === null ? null : this.name(boardId),
            file: rest.file ?? null,
            line: null,
            params: rest.params,
            text: rest.text,
        };
    }

    private static state(findings: Finding[], checked: number): CheckState {
        return { state: findings.length > 0 ? "findings" : "ok", reason: null, checked };
    }
}
