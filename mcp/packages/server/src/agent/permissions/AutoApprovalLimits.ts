import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { posix, win32 } from "path";

/** The project a check runs for. */
export interface AutoApprovalArea {
    /** folder Claude works in */
    cwd: string;
    /** whether an absolute path lies in the project or a folder linked to it */
    contains(path: string): boolean;
}

/**
 * Limits of the permission mode `auto`: what it refuses instead of approving, because nobody looks.
 *
 * - Files outside the project and its linked folders are not changed, and credentials there are not
 *   read. A command that names a path outside is refused, as it may change it; the temporary folder
 *   is open to commands.
 * - Nothing goes out to other people or services: pushes, releases, deployments, uploads, remote
 *   shells, published pages.
 * - No command takes other rights or changes what the computer runs by itself.
 *
 * Like `ToolPermissionPolicy` this reads what a command names; it is no sandbox. An interpreter or
 * a project script can do what its own command line does not show.
 */
export class AutoApprovalLimits {
    private static readonly CHANGE_OUTSIDE =
        "The user is away, so nothing outside the project is changed. Work inside the project, and tell the " +
        "user in your reply what is left for them to do.";
    private static readonly PUBLISH =
        "The user is away, and nothing is published, pushed, deployed or sent without their click. Go on with " +
        "the rest, and tell the user in your reply what is left for them to do.";
    private static readonly SYSTEM =
        "The user is away, so commands with other rights or changes to the computer's setup do not run. Go on " +
        "with the rest, and tell the user in your reply what is left for them to do.";
    private static readonly CREDENTIALS =
        "The user is away, so files that hold passwords or keys are not read. Go on without them.";

    /** tools of Claude Code that reach other people or services, or run things later */
    private static readonly OUTWARD_TOOLS =
        /^(?:Artifact\w*|RemoteTrigger|Cron\w+|Schedule\w*|PushNotification|SendUser\w*|Share\w*|ReportFindings)$/;

    private static readonly CREDENTIAL_PATH =
        /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.claude|\.config[\\/](?:gcloud|gh|op)|\.password-store|keyrings|\.mozilla)(?:[\\/]|$)|(?:^|[\\/])(?:\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.claude\.json|\.env(?:\.[\w.-]+)?|id_(?:rsa|ed25519|ecdsa)|[\w.-]+\.(?:pem|p12|pfx|key|kdbx))$/i;

    /** words that only start another command */
    private static readonly PREFIXES = new Set([
        ..."command exec env nohup time nice setsid stdbuf timeout xargs builtin then do else if while until !".split(
            " "
        ),
        ..."npx bunx pnpx dlx corepack".split(" "),
    ]);
    private static readonly SHELLS = new Set("sh bash zsh dash ksh fish cmd powershell pwsh eval".split(" "));
    private static readonly SYSTEM_PROGRAMS = new Set(
        "sudo su doas pkexec runas crontab at batch systemctl launchctl schtasks reg shutdown reboot mkfs mount umount".split(
            " "
        )
    );
    /** programs whose use is to reach other people or services */
    private static readonly OUTWARD_PROGRAMS = new Set(
        (
            "vercel now netlify wrangler firebase surge flyctl fly heroku eas railway render gcloud gsutil aws az doctl " +
            "kubectl helm terraform pulumi fastlane serverless sls gh-pages supabase amplify rclone s3cmd twine " +
            "ngrok cloudflared lt localtunnel ssh scp sftp ftp telnet nc ncat netcat mail mailx sendmail mutt"
        ).split(" ")
    );
    /** programs whose arguments are text, not commands */
    private static readonly TEXT_PROGRAMS = new Set("git echo printf grep rg ag sed".split(" "));
    private static readonly MAX_DEPTH = 4;
    private static readonly PACKAGE_TOOLS = new Set(
        "npm pnpm yarn bun cargo gem poetry uv flit hatch mvn gradle gradlew dotnet nuget docker podman make just task expo lerna nx turbo".split(
            " "
        )
    );
    private static readonly PUBLISH_WORD = /^(?:publish|deploy|push|upload|release)(?:$|[:._-])/i;
    private static readonly FORGES = new Set(["gh", "glab", "hub"]);
    private static readonly FORGE_READS = new Set(["view", "list", "status", "diff", "checks", "ls"]);
    private static readonly LOOPBACK = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/i;
    /** publishing commands in text that another program runs */
    private static readonly HIDDEN_PUBLISH =
        /\bgit\b[^;&|\n]{0,80}?(?<!stash )\bpush\b|\b(?:npm|pnpm|yarn|cargo)\s+publish\b/;
    private static readonly HOME_WORD =
        /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE|\$env:HOME)(?=$|[\\/])/i;
    private static readonly DEVICES = /^\/dev\/(?:null|zero|stdin|stdout|stderr|tty|u?random|fd(?:\/\d+)?)$/;

    private readonly paths: typeof posix;

    /**
     * @param area - the project
     * @param platform - the platform whose path rules apply
     */
    constructor(
        private readonly area: AutoApprovalArea,
        private readonly platform: NodeJS.Platform = process.platform
    ) {
        this.paths = platform === "win32" ? win32 : posix;
    }

    /**
     * Checks a file tool use outside the project.
     *
     * @param paths - the paths outside the project
     * @param isRead - whether the tool only reads
     * @returns the reason Claude is told, or null to approve
     */
    public files(paths: string[], isRead: boolean): string | null {
        if (!isRead) {
            return AutoApprovalLimits.CHANGE_OUTSIDE;
        }
        return paths.some((path) => AutoApprovalLimits.CREDENTIAL_PATH.test(path))
            ? AutoApprovalLimits.CREDENTIALS
            : null;
    }

    /**
     * Checks a use of a tool the policy knows nothing about.
     *
     * @param toolName - the tool
     * @param input - its input
     * @returns the reason Claude is told, or null to approve
     */
    public tool(toolName: string, input: Record<string, unknown>): string | null {
        if (AutoApprovalLimits.OUTWARD_TOOLS.test(toolName)) {
            return AutoApprovalLimits.PUBLISH;
        }
        return typeof input.command === "string" ? this.command(input.command) : null;
    }

    /**
     * Checks a shell command.
     *
     * @param command - the command
     * @returns the reason Claude is told, or null to approve
     */
    public command(command: string): string | null {
        return this.check(command, 0);
    }

    private check(text: string, depth: number): string | null {
        let cwd = this.area.cwd;
        for (const words of AutoApprovalLimits.commands(text)) {
            const rest = AutoApprovalLimits.withoutPrefixes(words);
            const program = AutoApprovalLimits.programName(rest[0] ?? "");
            const args = rest.slice(1);
            const refusal = this.program(program, args, depth);
            if (refusal !== null) {
                return refusal;
            }
            // the program itself may be anywhere: running it changes nothing there
            const skipped = words.length - rest.length;
            const named = words.filter((word, index) => index !== skipped || /^\d*&?[<>]/.test(word));
            if (named.some((word) => this.isOutside(word, cwd))) {
                return AutoApprovalLimits.CHANGE_OUTSIDE;
            }
            if (["cd", "pushd", "chdir", "set-location"].includes(program) && args[0] !== undefined) {
                cwd = this.resolve(args[0], cwd);
            }
        }
        return null;
    }

    private program(program: string, args: string[], depth: number): string | null {
        const words = args.filter((arg) => !arg.startsWith("-"));
        if (AutoApprovalLimits.SYSTEM_PROGRAMS.has(program)) {
            return AutoApprovalLimits.SYSTEM;
        }
        const outward =
            AutoApprovalLimits.OUTWARD_PROGRAMS.has(program) ||
            (program === "git" && AutoApprovalLimits.gitSends(args)) ||
            (AutoApprovalLimits.FORGES.has(program) &&
                !AutoApprovalLimits.FORGE_READS.has(words[1] ?? words[0] ?? "")) ||
            (AutoApprovalLimits.PACKAGE_TOOLS.has(program) &&
                words.slice(0, 3).some((word) => AutoApprovalLimits.PUBLISH_WORD.test(word))) ||
            (program === "rsync" && words.some((word) => /^[^/\\]+:/.test(word) && !/^[A-Za-z]:\\/.test(word))) ||
            (["curl", "wget"].includes(program) && AutoApprovalLimits.sendsData(args, words)) ||
            (!AutoApprovalLimits.TEXT_PROGRAMS.has(program) &&
                args.some((arg) => /\s/.test(arg) && AutoApprovalLimits.HIDDEN_PUBLISH.test(arg)));
        if (outward) {
            return AutoApprovalLimits.PUBLISH;
        }
        return depth < AutoApprovalLimits.MAX_DEPTH ? this.startedProgram(program, args, words, depth + 1) : null;
    }

    /** Checks the command another program starts, such as a shell or `find -exec`. */
    private startedProgram(program: string, args: string[], words: string[], depth: number): string | null {
        if (AutoApprovalLimits.SHELLS.has(program)) {
            return this.check(args.filter((arg) => !/^[-/][A-Za-z]+$/.test(arg)).join(" "), depth);
        }
        let started: string[] = [];
        if (program === "find") {
            started = args.slice(args.findIndex((arg) => /^-(?:exec|ok)(?:dir)?$/.test(arg)) + 1);
        } else if (/^python[\d.]*$/.test(program) && args[0] === "-m") {
            started = args.slice(1);
        } else if (AutoApprovalLimits.PACKAGE_TOOLS.has(program) && /^(?:dlx|exec|x|run)$/.test(words[0] ?? "")) {
            started = words.slice(1);
        }
        return started.length > 0
            ? this.program(AutoApprovalLimits.programName(started[0]), started.slice(1), depth)
            : null;
    }

    private static gitSends(args: string[]): boolean {
        const words: string[] = [];
        for (let index = 0; index < args.length; index++) {
            if (["-C", "-c", "--git-dir", "--work-tree"].includes(args[index])) {
                index++;
            } else if (!args[index].startsWith("-")) {
                words.push(args[index]);
            }
        }
        const [sub, next] = words;
        return (
            ["push", "send-email", "send-pack"].includes(sub) ||
            (["subtree", "lfs"].includes(sub) && next === "push") ||
            (sub === "svn" && next === "dcommit")
        );
    }

    /** Whether a curl or wget call sends data to another computer. */
    private static sendsData(args: string[], words: string[]): boolean {
        const sends = args.some(
            (arg, index) =>
                /^(?:-[sSkLif]*[dFT]|--data(?:-\w+)?|--form(?:-string)?|--upload-file|--json|--post-\w+|--body-\w+|--method)(?:=|$)/.test(
                    arg
                ) ||
                (/^(?:-[sSkLif]*X|--request)$/.test(arg) && !/^(?:GET|HEAD)$/i.test(args[index + 1] ?? ""))
        );
        const targets = words.filter((word) =>
            /^(?:https?:\/\/|localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+(?:[:/]|$))/i.test(word)
        );
        return sends && (targets.length === 0 || targets.some((target) => !AutoApprovalLimits.LOOPBACK.test(target)));
    }

    /** Whether a word of a command names a path outside the project. */
    private isOutside(word: string, cwd: string): boolean {
        const option = /^(?:--?[\w-]+|[A-Za-z_]\w*)=(.+)$/.exec(word) ?? /^-[A-Za-z](\/[^/].*|~\/.*)$/.exec(word);
        const path = (option ? option[1] : word).replace(/^\d*(?:&>>?|[<>]+&?)/, "");
        if (path === "" || /^-/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(path)) {
            return false;
        }
        const isHome = AutoApprovalLimits.HOME_WORD.test(path) || /^~[\w-]+(?:\/|$)/.test(path);
        const climbs = path.split(/[\\/]/).includes("..");
        if (!isHome && !climbs && !this.isAbsolutePath(path)) {
            return false;
        }
        const absolute = this.resolve(path, cwd);
        if (AutoApprovalLimits.DEVICES.test(absolute) || this.isBelow(tmpdir(), absolute)) {
            return false;
        }
        return !this.area.contains(absolute);
    }

    private isAbsolutePath(word: string): boolean {
        if (this.platform === "win32") {
            // `/q` is a switch there, `/c/Users` a path of Git Bash
            return /^[A-Za-z]:[\\/]|^\\\\|^\/[A-Za-z]\//.test(word);
        }
        if (!posix.isAbsolute(word)) {
            return false;
        }
        // an expression such as `/api/` is no path; without its top folder nothing can be there
        const top = word.split("/").find((part) => part !== "");
        return top === undefined || /[*?[{]/.test(top) || existsSync(`/${top}`);
    }

    private resolve(path: string, cwd: string): string {
        return this.paths.resolve(
            cwd,
            path.replace(AutoApprovalLimits.HOME_WORD, () => homedir())
        );
    }

    private isBelow(folder: string, path: string): boolean {
        const rel = this.paths.relative(folder, path);
        return rel === "" || (!rel.startsWith("..") && !this.paths.isAbsolute(rel));
    }

    private static withoutPrefixes(words: string[]): string[] {
        let index = 0;
        while (index < words.length) {
            const word = words[index];
            const isPrefix = AutoApprovalLimits.PREFIXES.has(AutoApprovalLimits.programName(word));
            const afterPrefix = index > 0 && (word.startsWith("-") || /^\d+[smhd]?$/.test(word));
            if (!isPrefix && !afterPrefix && !/^[A-Za-z_]\w*=/.test(word)) {
                break;
            }
            index++;
        }
        return words.slice(index);
    }

    private static programName(word: string): string {
        return (word.split(/[\\/]/).pop() ?? "")
            .toLowerCase()
            .replace(/(?<=.)@.*$/, "")
            .replace(/\.(?:exe|cmd|bat)$/, "");
    }

    /**
     * Splits a command line into its simple commands and their words, without quotes. Quoted text
     * stays one word; the commands of `$( )`, backticks and parentheses count on their own.
     */
    private static commands(text: string): string[][] {
        const commands: string[][] = [];
        const nested: string[] = [];
        let words: string[] = [];
        let word = "";
        let quoted = false;
        let quote = "";
        const endWord = () => {
            if (word !== "" || quoted) {
                words.push(word);
            }
            word = "";
            quoted = false;
        };
        const endCommand = () => {
            endWord();
            if (words.length > 0) {
                commands.push(words);
            }
            words = [];
        };
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            const isSubstitution = quote !== "'" && (char === "`" || (char === "$" && text[index + 1] === "("));
            if (isSubstitution) {
                const end = AutoApprovalLimits.substitutionEnd(text, index);
                nested.push(text.slice(char === "`" ? index + 1 : index + 2, end));
                index = end;
                // its output may be any word; it is no empty one
                word += "\u2026";
            } else if (quote !== "") {
                if (char === quote) {
                    quote = "";
                } else if (quote === '"' && char === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) {
                    word += text[++index];
                } else {
                    word += char;
                }
            } else if (char === "'" || char === '"') {
                quote = char;
                quoted = true;
            } else if (char === "\\" && /[\s"'\\$`;&|()<>]/.test(text[index + 1] ?? "")) {
                word += text[++index];
            } else if (/[;\n|()]/.test(char) || (char === "&" && !/[<>]$/.test(word) && text[index + 1] !== ">")) {
                endCommand();
            } else if (/\s/.test(char)) {
                // the target of a redirection belongs to its word
                if (!/^\d*(?:&>>?|[<>]+&?)$/.test(word)) {
                    endWord();
                }
            } else if (/[<>]/.test(char) && word !== "" && !/^(?:\d+|\d*&?[<>]*)$/.test(word)) {
                endWord();
                word = char;
            } else {
                word += char;
            }
        }
        endCommand();
        return [...commands, ...nested.flatMap((inner) => AutoApprovalLimits.commands(inner))];
    }

    /** Index of the character that ends the substitution starting at `start`. */
    private static substitutionEnd(text: string, start: number): number {
        if (text[start] === "`") {
            const end = text.indexOf("`", start + 1);
            return end < 0 ? text.length : end;
        }
        let depth = 0;
        for (let index = start + 1; index < text.length; index++) {
            depth += text[index] === "(" ? 1 : text[index] === ")" ? -1 : 0;
            if (depth === 0) {
                return index;
            }
        }
        return text.length;
    }
}
