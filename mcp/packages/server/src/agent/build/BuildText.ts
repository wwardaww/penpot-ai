import type { Persona } from "@penpot/mcp-common";
import type { CommandOutcome } from "./CommandExecutor";

/** Step of a build, as reported in `progress` events (`payload.step`). */
export type BuildStep =
    "read" | "plan" | "prepare" | "prebuild" | "scaffold" | "screen" | "cleanup" | "install" | "check" | "fix" | "save";

/**
 * Wording of the build pipeline for the two personas.
 *
 * Designers get outcome language only: no commands, paths, ids or error output. Developers get
 * the technical names.
 */
export class BuildText {
    private static readonly MAX_ERROR_CHARS = 4000;

    constructor(private readonly persona: Persona) {}

    public get isDeveloper(): boolean {
        return this.persona === "developer";
    }

    public step(step: BuildStep, detail?: string): string {
        const dev = this.isDeveloper;
        switch (step) {
            case "read":
                return "Reading the design";
            case "plan":
                return dev ? "Planning the app structure" : "Working out how the app will work";
            case "prepare":
                return "Getting ready";
            case "prebuild":
                return dev ? `Running ${detail}` : "Preparing the design for the app";
            case "scaffold":
                return dev ? `Scaffolding ${detail}` : "Setting up the app";
            case "screen":
                return detail ?? "Building a screen";
            case "cleanup":
                return dev ? "Removing deleted screens" : "Removing the screens you deleted";
            case "install":
                return dev ? (detail ?? "Installing dependencies") : "Getting what the app needs";
            case "check":
                return dev ? (detail ?? "Building") : "Checking that everything works";
            case "fix":
                return dev ? `Fixing build errors (attempt ${detail})` : "Fixing a small problem";
            case "save":
                return dev ? "Committing to app-src" : "Saving the app";
        }
    }

    public screen(name: string, update: boolean): string {
        return update ? `Updating ${name}` : `Building ${name}`;
    }

    public question(mode: "full" | "incremental" | "none"): string {
        if (mode === "none") {
            return this.isDeveloper
                ? "No design changes since the last build. Rebuild from scratch?"
                : "Nothing changed since the last build. Build everything again?";
        }
        return this.isDeveloper ? "Generate the app with this plan?" : "Build it?";
    }

    public nothingChanged(): string {
        return this.isDeveloper
            ? "No board changed since the last build; app-src is up to date."
            : "Your app already matches the design. Nothing changed since the last build.";
    }

    public incrementalSummary(changed: string[], added: string[], removed: string[]): string {
        const parts: string[] = [];
        if (changed.length > 0) {
            parts.push(`update ${BuildText.list(changed)} to match your latest changes`);
        }
        if (added.length > 0) {
            parts.push(`add ${BuildText.list(added)} as new ${added.length === 1 ? "screen" : "screens"}`);
        }
        if (removed.length > 0) {
            parts.push(`remove ${BuildText.list(removed)}`);
        }
        const sentence = `I'll ${parts.join(", then ")}.`;
        return this.isDeveloper
            ? `${sentence} Only the files of these screens are regenerated; everything else stays as it is.`
            : `${sentence} Everything else stays as it is.`;
    }

    public notNow(): string {
        return this.isDeveloper ? "Build cancelled." : "Okay, nothing was built.";
    }

    public noBoards(): string {
        return this.isDeveloper
            ? "The file has no top-level boards; there is nothing to build."
            : "There is nothing to build yet. Add a board for each screen of your app first.";
    }

    public planFailed(): string {
        return this.isDeveloper
            ? "Claude did not return a valid build plan (JSON block missing or invalid)."
            : "I couldn't work out a plan this time. Please try Build again.";
    }

    public stalePlan(): string {
        return this.isDeveloper
            ? "The plan is out of date or missing; run build-plan again."
            : "The design changed since the plan was made. Please press Build again.";
    }

    public busy(): string {
        return this.isDeveloper
            ? "A build is already running for this project."
            : "The app is already being built. Please wait for it to finish.";
    }

    public gaveUp(command: string[], outcome: CommandOutcome, attempts: number): string {
        if (!this.isDeveloper) {
            return "I couldn't get the app working this time. Your design is safe; please try Build again.";
        }
        const status = outcome.timedOut ? "timed out" : `exited with code ${outcome.code}`;
        return (
            `Build failed after ${attempts} fix attempts: \`${command.join(" ")}\` ${status}.\n` +
            BuildText.tail(outcome.output, BuildText.MAX_ERROR_CHARS)
        );
    }

    /** Last part of a command output. */
    public static tail(text: string, maxChars: number): string {
        return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
    }

    private static list(names: string[]): string {
        if (names.length <= 1) {
            return names.join("");
        }
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }
}
