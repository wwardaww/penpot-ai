import type { PreviewLogMessage, PreviewState } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { HttpProbe } from "./HttpProbe";
import { ProcessTree } from "./ProcessTree";
import type { StackConfig } from "./StackConfig";

/** Status of a dev server, as reported by `preview.status`. */
export interface PreviewStatus {
    state: PreviewState;
    url?: string;
    message?: string;
    restarts: number;
}

/** Output line of a dev server. */
export interface LogLine {
    stream: PreviewLogMessage["stream"];
    text: string;
}

/** Receiver of a dev server's status changes and output. */
export interface DevServerObserver {
    onStatus(status: PreviewStatus): void;
    onLog(line: LogLine): void;
}

/** Tunables of a dev server. */
export interface DevServerOptions {
    /** restarts after crashes before the server is given up */
    maxRestarts: number;
    /** pause between readiness probes */
    probeIntervalMs: number;
    /** pause before a restart */
    restartDelayMs: number;
}

/**
 * Dev server of one project's generated app.
 *
 * Runs the stack's dev command in its own process tree with the assigned port, reports `starting`
 * until the server answers HTTP, then `ready`. Restarts it after a crash (up to
 * {@link DevServerOptions.maxRestarts} times), reports `failed` when it does not come up in time
 * or keeps crashing, and kills the whole tree on {@link stop}. Servers that ignore the port and
 * announce another loopback URL in their output are found on that port instead.
 */
export class DevServer {
    /** Number of output lines kept for clients that join later. */
    public static readonly LOG_LIMIT = 200;

    private static readonly MAX_LINE_LENGTH = 2000;
    // eslint-disable-next-line no-control-regex
    private static readonly ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
    private static readonly ANNOUNCED_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/;

    private readonly logger = createLogger("DevServer");
    private readonly probe: HttpProbe;
    private readonly logs: LogLine[] = [];
    private readonly partial = new Map<LogLine["stream"], string>();
    private readonly announcedPorts = new Set<number>();
    private status: PreviewStatus;
    private tree?: ProcessTree;
    private restartTimer?: NodeJS.Timeout;
    /** incremented on every launch and on stop; stale callbacks compare against it */
    private generation = 0;
    private stopped = false;

    /**
     * @param projectId - the project
     * @param stack - the project's stack settings
     * @param port - the assigned port
     * @param observer - receives status changes and output
     * @param options - tunables
     */
    constructor(
        public readonly projectId: string,
        private readonly stack: StackConfig,
        public readonly port: number,
        private readonly observer: DevServerObserver,
        private readonly options: DevServerOptions
    ) {
        this.probe = new HttpProbe(stack.readyPath);
        this.status = { state: "starting", url: DevServer.urlFor(port), restarts: 0 };
    }

    /** Current status. */
    public get currentStatus(): PreviewStatus {
        return { ...this.status };
    }

    /** Whether the server is starting or ready. */
    public get isLive(): boolean {
        return this.status.state === "starting" || this.status.state === "ready";
    }

    /** Buffered output lines, oldest first. */
    public get recentLogs(): LogLine[] {
        return [...this.logs];
    }

    /** Process id of the running tree's root, if any. */
    public get pid(): number | undefined {
        return this.tree?.hasExited ? undefined : this.tree?.pid;
    }

    /**
     * Starts the dev command.
     */
    public start(): void {
        this.launch();
    }

    /**
     * Kills the process tree and reports `stopped`.
     *
     * @param message - why it stopped, for the client
     */
    public async stop(message?: string): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.generation++;
        clearTimeout(this.restartTimer);
        await this.tree?.kill();
        if (this.status.state !== "failed") {
            this.log("system", "Dev server stopped");
            this.setStatus({ state: "stopped", message });
        }
    }

    /**
     * Kills the process tree synchronously; for daemon exit.
     */
    public killSync(): void {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.restartTimer);
        this.tree?.killSync();
    }

    private launch(): void {
        const generation = ++this.generation;
        this.announcedPorts.clear();
        this.partial.clear();
        const command = this.stack.commandFor(this.port);
        this.setStatus({ state: "starting", url: DevServer.urlFor(this.port) });
        this.log("system", `$ ${command}  (port ${this.port})`);
        this.logger.info("Starting dev server of project %s on port %d: %s", this.projectId, this.port, command);

        const tree = new ProcessTree(command, {
            cwd: this.stack.cwd,
            env: {
                ...process.env,
                [this.stack.portEnv]: String(this.port),
                BROWSER: "none",
                FORCE_COLOR: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.tree = tree;
        tree.child.stdout?.on("data", (chunk: Buffer) => this.output("stdout", chunk));
        tree.child.stderr?.on("data", (chunk: Buffer) => this.output("stderr", chunk));
        tree.child.once("error", (error) => this.log("system", `Could not start the dev server: ${error.message}`));
        tree.waitForExit().then(() => this.exited(generation, tree.child.exitCode));
        void this.waitUntilReady(generation);
    }

    private async waitUntilReady(generation: number): Promise<void> {
        const deadline = Date.now() + this.stack.readyTimeoutMs;
        while (this.isCurrent(generation) && this.status.state === "starting") {
            for (const port of [this.port, ...this.announcedPorts]) {
                if (await this.probe.answers(port)) {
                    if (this.isCurrent(generation) && this.status.state === "starting") {
                        this.log("system", `Dev server ready on port ${port}`);
                        this.setStatus({ state: "ready", url: DevServer.urlFor(port) });
                    }
                    return;
                }
            }
            if (Date.now() > deadline) {
                if (this.isCurrent(generation)) {
                    await this.fail("The app did not start in time.");
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, this.options.probeIntervalMs));
        }
    }

    private exited(generation: number, code: number | null): void {
        this.flush();
        if (!this.isCurrent(generation)) {
            return;
        }
        this.log("system", `Dev server exited${code === null ? "" : ` with code ${code}`}`);
        if (this.status.restarts >= this.options.maxRestarts) {
            void this.fail("The app stopped and could not be restarted.");
            return;
        }
        const restarts = this.status.restarts + 1;
        // ends the readiness loop of the crashed process
        const pending = ++this.generation;
        this.setStatus({ state: "starting", restarts, message: "Restarting the app" });
        this.restartTimer = setTimeout(() => {
            if (this.isCurrent(pending)) {
                this.log("system", `Restarting (${restarts} of ${this.options.maxRestarts})`);
                this.launch();
            }
        }, this.options.restartDelayMs);
    }

    private async fail(message: string): Promise<void> {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.restartTimer);
        this.log("system", message);
        this.logger.warn("Dev server of project %s failed: %s", this.projectId, message);
        await this.tree?.kill();
        this.setStatus({ state: "failed", message });
    }

    private isCurrent(generation: number): boolean {
        return generation === this.generation && !this.stopped;
    }

    private output(stream: LogLine["stream"], chunk: Buffer): void {
        const text = (this.partial.get(stream) ?? "") + chunk.toString("utf8");
        const lines = text.split(/\r?\n/);
        this.partial.set(stream, lines.pop() ?? "");
        for (const line of lines) {
            this.line(stream, line);
        }
    }

    private flush(): void {
        for (const [stream, rest] of this.partial) {
            if (rest.length > 0) {
                this.line(stream, rest);
            }
        }
        this.partial.clear();
    }

    private line(stream: LogLine["stream"], raw: string): void {
        const text = raw.replace(DevServer.ANSI, "").slice(0, DevServer.MAX_LINE_LENGTH);
        if (text.trim().length === 0) {
            return;
        }
        if (this.status.state === "starting") {
            const match = text.match(DevServer.ANNOUNCED_URL);
            const announced = match ? Number(match[1]) : NaN;
            if (Number.isInteger(announced) && announced !== this.port && announced <= 65535) {
                this.announcedPorts.add(announced);
            }
        }
        this.log(stream, text);
    }

    private log(stream: LogLine["stream"], text: string): void {
        const line = { stream, text };
        this.logs.push(line);
        if (this.logs.length > DevServer.LOG_LIMIT) {
            this.logs.shift();
        }
        this.notify(() => this.observer.onLog(line));
    }

    private setStatus(change: Partial<PreviewStatus> & Pick<PreviewStatus, "state">): void {
        this.status = {
            state: change.state,
            url: change.url ?? this.status.url,
            message: change.message,
            restarts: change.restarts ?? this.status.restarts,
        };
        const status = this.currentStatus;
        this.notify(() => this.observer.onStatus(status));
    }

    private notify(call: () => void): void {
        try {
            call();
        } catch (error) {
            this.logger.warn("Dev server observer failed: %s", error instanceof Error ? error.message : error);
        }
    }

    private static urlFor(port: number): string {
        return `http://localhost:${port}/`;
    }
}
