import { CodeNames } from "./CodeNames";
import { ConformanceChecker } from "./ConformanceChecker";
import type { Finding } from "./ConformanceReport";
import type { DesignContract } from "./DesignContract";
import { MotionFile } from "./MotionFile";
import { type MotionLibraryId } from "./MotionCode";
import { type PrototypeLink, PrototypeLinks } from "./PrototypeLinks";

/** Screen of the plan. */
export interface PromptScreen {
    boardId: string;
    name: string;
    route: string;
}

/**
 * Lines of the build prompts that tell Claude what the app must follow: flows, components of the
 * design system and the generated animations.
 */
export class ContractPrompt {
    private static readonly MAX_LINES = 60;

    /**
     * @param contract - the design contract
     * @param screens - screens of the plan that are not removed
     */
    constructor(
        private readonly contract: DesignContract,
        private readonly screens: PromptScreen[]
    ) {}

    /**
     * Lines for the whole app (scaffold and app-wide turns).
     *
     * @param library - animation library of the stack
     * @param motion - the motion file, null before it is written
     */
    public appLines(library: MotionLibraryId, motion: MotionFile | null): string[] {
        const lines: string[] = [];
        const flows = this.contract.flows.flatMap((flow) => {
            const screen = this.screen(flow.startingBoardId);
            return screen ? [`- flow "${flow.name}" starts at "${screen.name}" (${screen.route})`] : [];
        });
        if (flows.length > 0) {
            lines.push("", "## Prototype flows", "The app opens on the start screen of the first flow:", ...flows);
        }
        const overlays = [...this.contract.overlays].flatMap((boardId) => {
            const openers = PrototypeLinks.openers(this.contract.links, boardId).map((id) => `"${this.name(id)}"`);
            return openers.length > 0
                ? [
                      `- "${this.name(boardId)}" (board ${boardId}) as component ${CodeNames.component(this.name(boardId))}, opened from ${openers.join(", ")}`,
                  ]
                : [];
        });
        if (overlays.length > 0) {
            lines.push("", "Boards shown as overlays (modal, sheet, menu); they get no route:", ...overlays);
        }
        const components = ConformanceChecker.required(this.contract);
        if (components.length > 0) {
            lines.push(
                "",
                this.contract.designSystem === null
                    ? "## Components of the design"
                    : `## Design system "${this.contract.designSystem}"`,
                "Make exactly one code component for each, with its variants as props, and reuse it on every",
                "screen that has it. Colors, sizes and fonts come from the theme, never from literal values.",
                ...ContractPrompt.cut(
                    components.map((component) => {
                        const boards = Object.keys(component.boards)
                            .map((boardId) => this.name(boardId))
                            .filter((name) => name.length > 0);
                        return `- "${component.design}" → ${CodeNames.component(component.name.split(/[,=]/)[0])}${boards.length > 0 ? ` (on ${[...new Set(boards)].join(", ")})` : ""}`;
                    })
                )
            );
        }
        if (this.contract.animations.length > 0) {
            lines.push(...ContractPrompt.animationLines(library, motion));
        }
        return lines;
    }

    /**
     * Lines for one screen: its links, the overlays built with it, its components and animations.
     *
     * @param boardId - the screen's board
     * @param motion - the motion file
     */
    public screenLines(boardId: string, motion: MotionFile | null): string[] {
        const lines: string[] = [];
        const overlays = [...this.contract.overlays].filter((overlay) =>
            PrototypeLinks.openers(this.contract.links, overlay).includes(boardId)
        );
        for (const overlay of overlays) {
            const own = this.contract.links.filter((link) => link.from === overlay);
            lines.push(
                "",
                `Overlay of this screen: "${this.name(overlay)}" (board ${overlay}); build it as the component ${CodeNames.component(this.name(overlay))}, look at its board too.`,
                ...own.flatMap((link) => this.linkLine(link))
            );
        }
        const boards = [boardId, ...overlays];
        const components = ConformanceChecker.required(this.contract).filter((component) =>
            boards.some((board) => component.boards[board] !== undefined)
        );
        if (components.length > 0) {
            lines.push(
                "",
                "Design components on this screen (use their code components, do not copy their markup):",
                ...ContractPrompt.cut(
                    components.map(
                        (component) =>
                            `- "${component.design}" → ${CodeNames.component(component.name.split(/[,=]/)[0])}`
                    )
                )
            );
        }
        const entries = motion?.entries.filter((entry) => boards.includes(entry.layer.boardId)) ?? [];
        if (motion !== null && entries.length > 0) {
            lines.push(
                "",
                `Animations of this screen; apply every one from \`${motion.file}\` (do not write your own values):`,
                ...ContractPrompt.cut(
                    entries.map((entry) => {
                        const stagger = entry.motion.enter?.stagger ?? entry.motion.exit?.stagger ?? null;
                        return `- "${entry.layer.path || entry.layer.name}": ${motion.references(entry).join(", ")}${stagger ? ` (its ${entry.layer.childCount} children one after the other)` : ""}`;
                    })
                )
            );
        }
        return lines;
    }

    /**
     * Navigation lines of a screen; null when the prototype could not be read.
     *
     * @param boardId - the screen's board
     */
    public navigationLines(boardId: string): string[] | null {
        if (this.contract.unread.some((entry) => entry.part === "prototype")) {
            return null;
        }
        return this.contract.links.filter((link) => link.from === boardId).flatMap((link) => this.linkLine(link));
    }

    private linkLine(link: PrototypeLink): string[] {
        const on = `- ${link.trigger}${link.trigger === "after-delay" && link.delay !== null ? ` (${link.delay} ms)` : ""} on "${link.sourceName}"`;
        switch (link.type) {
            case "navigate": {
                const target = link.to === null ? null : this.screen(link.to);
                return target ? [`${on} → "${target.name}" (${target.route})`] : [];
            }
            case "open-overlay":
            case "toggle-overlay":
                return [
                    `${on} → ${link.type === "toggle-overlay" ? "toggles" : "opens"} the overlay "${this.name(link.to ?? "")}"${link.overlay ? ` (${link.overlay})` : ""}`,
                ];
            case "close-overlay":
                return [`${on} → closes the overlay`];
            case "previous-screen":
                return [`${on} → back to the previous screen`];
            case "open-url":
                return link.url ? [`${on} → opens ${link.url}`] : [];
        }
    }

    /** How to use the motion file with a library. */
    private static animationLines(library: MotionLibraryId, motion: MotionFile | null): string[] {
        const file = motion === null ? "`penforge/motion`" : `\`${motion.file}\``;
        const how: Record<MotionLibraryId, string[]> = {
            "framer-motion": [
                "Add `framer-motion` to package.json. Spread the props on `motion.*` elements; exits need",
                "`AnimatePresence`, smart transitions a shared `layoutId` with the given transition.",
            ],
            reanimated: [
                "Add `react-native-reanimated` (and its Babel plugin when the Expo version needs it). Drive",
                "shared values with the data: `withTiming` + `Easing.bezier`, `withSpring`, `withRepeat`, `withDelay`.",
            ],
            css: ["Import the stylesheet once in the app's entry and put its classes on the elements."],
        };
        return [
            "",
            "## Animations",
            `Penforge writes the animations of the design to ${file} before the screens are built; it is`,
            "generated, so never edit or copy it. Apply its motions so the app moves exactly as in Penpot.",
            ...how[library],
            "Respect `prefers-reduced-motion` (no motion then, same end state).",
        ];
    }

    /**
     * Prompt of a turn that fixes findings.
     *
     * @param findings - what to fix
     */
    public static fix(findings: Finding[]): string {
        return [
            "## Step: make the app follow the design",
            "",
            "Penforge compared the code with the design. Fix every point in the code of the app, and",
            "nothing else. A point that an instruction of the user asked for on purpose stays as it is. Do",
            "not edit generated files (the motion file, the token block) and do not run commands.",
            "",
            ...findings.map((finding, index) => `${index + 1}. [${finding.code}] ${finding.text}`),
            "",
            "End your reply with a ```json block:",
            "```json",
            '{ "files": ["src/…"], "components": [{ "design": "Cards/Task card", "name": "TaskCard", "file": "src/components/TaskCard.tsx" }] }',
            "```",
        ].join("\n");
    }

    private screen(boardId: string): PromptScreen | null {
        return this.screens.find((screen) => screen.boardId === boardId) ?? null;
    }

    private name(boardId: string): string {
        return this.screen(boardId)?.name ?? this.contract.boards.find((board) => board.id === boardId)?.name ?? "";
    }

    private static cut(lines: string[]): string[] {
        return lines.length > ContractPrompt.MAX_LINES
            ? [...lines.slice(0, ContractPrompt.MAX_LINES), `- …and ${lines.length - ContractPrompt.MAX_LINES} more`]
            : lines;
    }
}
