import type { PreviewLogMessage, PreviewReason, PreviewState } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { ChildEnvironment } from "../build/ChildEnvironment";
import { CommandLauncher } from "./CommandLauncher";
import { ExposureCheck } from "./ExposureCheck";
import { HttpProbe } from "./HttpProbe";
import { LoopbackGuard } from "./LoopbackGuard";
import type { PortPool } from "./PortPool";
import { ProcessTree } from "./ProcessTree";
import type { StackConfig } from "./StackConfig";

/** Status of a dev server, as reported by `preview.status`. */
export interface PreviewStatus {
    state: PreviewState;
    url?: string;
    /** why it is restarting, stopped or failed */
    reason?: PreviewReason;
    /** technical detail, in English */
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

/**
 * Who may reach a dev server.
 *
 * `loopback` (the default): only this computer; the server is forced onto `127.0.0.1` and checked
 * before it is reported ready. `lan`: also other devices on the local network (the phone preview,
 * after the user agreed); `host` is the address the server advertises to them.
 */
export type DevServerExposure = { mode: "loopback" } | { mode: "lan"; host: string };

/** Tunables of a dev server. */
export interface DevServerOptions {
    /** restarts after crashes before the server is given up */
    maxRestarts: number;
    /** pause between readiness probes */
    probeIntervalMs: number;
    /** pause before a restart */
    restartDelayMs: number;
    /** time a server must stay ready before a crash no longer counts against the restart limit */
    healthyMs: number;
    /** environment the child environment is derived from (secrets are dropped) */
    baseEnv: NodeJS.ProcessEnv;
    /** check that a loopback server cannot be reached from the network; a default one when unset */
    exposureCheck?: ExposureCheck;
}

/**
 * Dev server of one project's generated app.
 *
 * Runs the stack's dev command (an argument vector, no shell) in its own process tree with the
 * assigned port and an environment free of secrets. By default the server stays on the loopback
 * interface: `HOST` is `127.0.0.1`, a Node preload ({@link LoopbackGuard}) binds every server of
 * the command to `127.0.0.1`, and before `ready` the server is checked from the machine's network
 * addresses ({@link ExposureCheck}); one reachable from there is stopped and reported `failed`
 * (`exposed`). With the `lan` exposure (phone preview) it may listen on all interfaces. Reports `starting` until the server answers HTTP, then `ready`.
 * Restarts it after a crash (up to {@link DevServerOptions.maxRestarts} times in a row; a server
 * that stayed up for {@link DevServerOptions.healthyMs} starts counting again), reports `failed`
 * when it does not come up in time or keeps crashing, and kills the whole tree on {@link stop}.
 *
 * The assigned port is always probed first. A server that ignores it may announce a loopback URL
 * in its output; that port is used only if it lies in the daemon's port pool and can be reserved
 * there, so URLs of unrelated services (proxy targets, other apps) are ignored.
 */
export class DevServer {
    /** Number of output lines kept for clients that join later. */
    public static readonly LOG_LIMIT = 200;

    private static readonly MAX_LINE_LENGTH = 2000;
    // eslint-disable-next-line no-control-regex
    private static readonly ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
    private static readonly ANNOUNCED_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})(?![\d])/g;

    private readonly logger = createLogger("DevServer");
    private readonly probe: HttpProbe;
    private readonly exposureCheck: ExposureCheck;
    private readonly logs: LogLine[] = [];
    private readonly partial = new Map<LogLine["stream"], string>();
    private readonly claimed = new Set<number>();
    private status: PreviewStatus;
    private tree?: ProcessTree;
    private restartTimer?: NodeJS.Timeout;
    private readyAt?: number;
    /** incremented on every launch and on stop; stale callbacks compare against it */
    private generation = 0;
    private stopped = false;

    /**
     * @param projectId - the project
     * @param stack - the project's stack settings
     * @param port - the assigned port (reserved in `ports`)
     * @param ports - the port pool, for ports the server announces itself
     * @param observer - receives status changes and output
     * @param options - tunables
     * @param exposure - who may reach the server; this computer only by default
     */
    constructor(
        public readonly projectId: string,
        private readonly stack: StackConfig,
        public readonly port: number,
        private readonly ports: PortPool,
        private readonly observer: DevServerObserver,
        private readonly options: DevServerOptions,
        public readonly exposure: DevServerExposure = { mode: "loopback" }
    ) {
        this.probe = new HttpProbe(stack.readyPath);
        this.exposureCheck = options.exposureCheck ?? new ExposureCheck();
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

    /** Ports the server announced and that were reserved for it in the pool. */
    public get claimedPorts(): number[] {
        return [...this.claimed];
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
     * @param reason - why it stopped
     */
    public async stop(reason: PreviewReason = "stopped"): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.generation++;
        clearTimeout(this.restartTimer);
        await this.tree?.kill();
        if (this.status.state !== "failed") {
            this.log("system", `Dev server stopped (${reason})`);
            this.setStatus({ state: "stopped", reason });
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
        this.partial.clear();
        this.readyAt = undefined;
        const argv = this.stack.argvFor(this.port);
        this.setStatus({
            state: "starting",
            url: DevServer.urlFor(this.port),
            reason: this.status.restarts > 0 ? "restarting" : undefined,
        });
        this.log("system", `> ${argv.join(" ")}  (port ${this.port})`);
        this.logger.info("Starting dev server of project %s on port %d: %s", this.projectId, this.port, argv.join(" "));

        const reach: Record<string, string> =
            this.exposure.mode === "lan"
                ? { REACT_NATIVE_PACKAGER_HOSTNAME: this.exposure.host }
                : { HOST: LoopbackGuard.HOST, NODE_OPTIONS: LoopbackGuard.nodeOptions() };
        const env = ChildEnvironment.scrub(this.options.baseEnv, {
            [this.stack.portEnv]: String(this.port),
            BROWSER: "none",
            FORCE_COLOR: "0",
            ...reach,
        });
        let tree: ProcessTree;
        try {
            const spec = new CommandLauncher(env).spawnSpec(argv);
            tree = new ProcessTree(spec, { cwd: this.stack.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            void this.fail("command-failed", error instanceof Error ? error.message : String(error));
            return;
        }
        this.tree = tree;
        tree.child.stdout?.on("data", (chunk: Buffer) => this.output("stdout", chunk));
        tree.child.stderr?.on("data", (chunk: Buffer) => this.output("stderr", chunk));
        tree.child.once("error", (error) => {
            if (tree.pid === undefined && this.isCurrent(generation)) {
                void this.fail("command-failed", `Could not start the dev server: ${error.message}`);
            }
        });
        tree.waitForExit().then(() => this.exited(generation, tree));
        void this.waitUntilReady(generation);
    }

    private async waitUntilReady(generation: number): Promise<void> {
        const deadline = Date.now() + this.stack.readyTimeoutMs;
        while (this.isCurrent(generation) && this.status.state === "starting") {
            // the assigned port first, then ports the server announced and that were reserved
            for (const port of [this.port, ...this.claimed]) {
                if (await this.probe.answers(port)) {
                    if (!(await this.loopbackOnly(generation, port))) {
                        return;
                    }
                    if (this.isCurrent(generation) && this.status.state === "starting") {
                        this.log("system", `Dev server ready on port ${port}`);
                        this.readyAt = Date.now();
                        this.setStatus({ state: "ready", url: DevServer.urlFor(port) });
                    }
                    return;
                }
            }
            if (Date.now() > deadline) {
                if (this.isCurrent(generation)) {
                    await this.fail("start-timeout", "The app did not answer in time");
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, this.options.probeIntervalMs));
        }
    }

    /**
     * Checks that a loopback server cannot be reached from the network; stops it otherwise.
     *
     * @returns whether the server may be reported ready
     */
    private async loopbackOnly(generation: number, port: number): Promise<boolean> {
        if (this.exposure.mode !== "loopback") {
            return true;
        }
        const exposed = await this.exposureCheck.exposedOn(port);
        if (exposed.length === 0) {
            return true;
        }
        if (this.isCurrent(generation)) {
            await this.fail(
                "exposed",
                `The app server listens on the network (${exposed.join(", ")}:${port}), not only on this computer; ` +
                    "it was stopped. Make its dev command bind 127.0.0.1."
            );
        }
        return false;
    }

    private exited(generation: number, tree: ProcessTree): void {
        this.flush();
        if (!this.isCurrent(generation) || tree.pid === undefined) {
            return;
        }
        const code = tree.child.exitCode;
        this.log("system", `Dev server exited${code === null ? "" : ` with code ${code}`}`);
        const healthy = this.readyAt !== undefined && Date.now() - this.readyAt >= this.options.healthyMs;
        const previous = healthy ? 0 : this.status.restarts;
        if (previous >= this.options.maxRestarts) {
            void this.fail("crashed", "The app stopped and could not be restarted");
            return;
        }
        const restarts = previous + 1;
        // ends the readiness loop of the crashed process
        const pending = ++this.generation;
        this.setStatus({ state: "starting", restarts, reason: "restarting" });
        this.restartTimer = setTimeout(() => {
            if (this.isCurrent(pending)) {
                this.log("system", `Restarting (${restarts} of ${this.options.maxRestarts})`);
                this.launch();
            }
        }, this.options.restartDelayMs);
    }

    private async fail(reason: PreviewReason, message: string): Promise<void> {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.restartTimer);
        this.log("system", message);
        this.logger.warn("Dev server of project %s failed: %s", this.projectId, message);
        await this.tree?.kill();
        this.setStatus({ state: "failed", reason, message });
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
            for (const match of text.matchAll(DevServer.ANNOUNCED_URL)) {
                const announced = Number(match[1]);
                if (announced !== this.port && !this.claimed.has(announced) && this.ports.claim(announced)) {
                    this.claimed.add(announced);
                }
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

    private setStatus(change: Omit<Partial<PreviewStatus>, "state"> & Pick<PreviewStatus, "state">): void {
        this.status = {
            state: change.state,
            url: change.url ?? this.status.url,
            reason: change.reason,
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
