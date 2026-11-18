import QRCode from "qrcode";
import { createLogger } from "../../logger";
import { CommandPolicy } from "../process/CommandPolicy";
import type { DevServerObserver, PreviewStatus } from "../process/DevServer";
import type { DevServerManager } from "../process/DevServerManager";
import { ExposureCheck } from "../process/ExposureCheck";
import { StackConfig } from "../process/StackConfig";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { PublishError } from "./PublishError";

/** QR code as rows of modules (`1` = dark). */
export interface QrMatrix {
    size: number;
    rows: string[];
}

/** Running phone preview. */
export interface PhoneSession {
    /** URL Expo Go opens (`exp://<address>:<port>`) */
    url: string;
    host: string;
    port: number;
    qr: QrMatrix;
    /** when the session ends by itself (ISO time) */
    expiresAt: string;
}

/**
 * Phone preview of Expo apps: Expo Go on a phone in the same network opens the running dev server.
 *
 * The dev server normally stays on this computer. For a session it restarts with LAN access
 * (advertising this computer's network address), the QR code of `exp://<address>:<port>` goes to
 * the client, and when the session ends (stopped, client gone, or after
 * {@link MAX_SESSION_MS}) the dev server restarts loopback only. One session per project; a new
 * one ends the previous one.
 */
export class PhonePreview {
    /** Longest session; the phone loses access afterwards. */
    public static readonly MAX_SESSION_MS = 30 * 60_000;

    private readonly logger = createLogger("PhonePreview");
    private readonly sessions = new Map<string, AbortController>();

    /**
     * @param devServers - the dev server manager
     * @param network - finds this computer's network address
     * @param maxSessionMs - longest session
     */
    constructor(
        private readonly devServers: DevServerManager,
        private readonly network: ExposureCheck = new ExposureCheck(),
        private readonly maxSessionMs: number = PhonePreview.MAX_SESSION_MS
    ) {}

    /**
     * Tells whether a project's stack has a phone preview (an Expo dev command).
     *
     * @param workspace - the project
     */
    public static async supports(workspace: ProjectWorkspace): Promise<boolean> {
        try {
            return PhonePreview.isExpo(await StackConfig.load(workspace, new CommandPolicy()));
        } catch {
            return false;
        }
    }

    /**
     * Runs a session until it is stopped.
     *
     * @param workspace - the project
     * @param signal - ends the session
     * @param onReady - receives the session once the phone can connect
     * @throws PublishError `no-phone-preview`, `no-network`, `preview-failed`
     */
    public async run(
        workspace: ProjectWorkspace,
        signal: AbortSignal,
        onReady: (session: PhoneSession) => void
    ): Promise<void> {
        let stack: StackConfig;
        try {
            stack = await StackConfig.load(workspace, new CommandPolicy());
        } catch {
            throw new PublishError("no-app", "There is no generated app to open on a phone yet");
        }
        if (!PhonePreview.isExpo(stack)) {
            throw new PublishError("no-phone-preview", `The ${stack.name} app has no phone preview`);
        }
        const host = await this.network.lanAddress();
        if (host === null) {
            throw new PublishError("no-network", "This computer has no local network address");
        }
        const projectId = workspace.projectId;
        this.sessions.get(projectId)?.abort();
        const own = new AbortController();
        this.sessions.set(projectId, own);
        const ended = AbortSignal.any([signal, own.signal, AbortSignal.timeout(this.maxSessionMs)]);

        const waiter = new ReadyWaiter();
        const watch = this.devServers.watch(projectId, waiter);
        try {
            this.logger.info("Opening the dev server of project %s to the local network (%s)", projectId, host);
            const status = await this.devServers.start(workspace, { exposure: { mode: "lan", host } });
            const ready = status.state === "ready" ? status : await waiter.ready(ended);
            const port = Number(new URL(ready.url ?? "").port);
            const url = `exp://${host}:${port}`;
            onReady({
                url,
                host,
                port,
                qr: PhonePreview.qr(url),
                expiresAt: new Date(Date.now() + this.maxSessionMs).toISOString(),
            });
            await new Promise<void>((resolve) => {
                if (ended.aborted) {
                    resolve();
                } else {
                    ended.addEventListener("abort", () => resolve(), { once: true });
                }
            });
        } finally {
            watch.dispose();
            if (this.sessions.get(projectId) === own) {
                this.sessions.delete(projectId);
                if (this.devServers.exposureOf(projectId)?.mode === "lan") {
                    this.logger.info("Closing the dev server of project %s to the local network", projectId);
                    await this.devServers
                        .start(workspace, { exposure: { mode: "loopback" } })
                        .catch((error) => this.logger.warn("Could not restart the dev server: %s", String(error)));
                }
            }
        }
    }

    /**
     * Encodes a text as a QR code.
     *
     * @param text - the text (a URL)
     */
    public static qr(text: string): QrMatrix {
        const modules = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
        const rows: string[] = [];
        for (let row = 0; row < modules.size; row++) {
            let line = "";
            for (let column = 0; column < modules.size; column++) {
                line += modules.get(row, column) ? "1" : "0";
            }
            rows.push(line);
        }
        return { size: modules.size, rows };
    }

    private static isExpo(stack: StackConfig): boolean {
        const argv = stack.devArgv;
        return argv.includes("expo") && argv.includes("start");
    }
}

/** Observer that waits for the restarted dev server. */
class ReadyWaiter implements DevServerObserver {
    private listener?: (status: PreviewStatus) => void;
    private last?: PreviewStatus;

    public onStatus(status: PreviewStatus): void {
        this.last = status;
        this.listener?.(status);
    }

    public onLog(): void {}

    /** Resolves with the next `ready` status; rejects on `failed` or when `signal` aborts. */
    public ready(signal: AbortSignal): Promise<PreviewStatus> {
        return new Promise((resolve, reject) => {
            const settle = (status: PreviewStatus) => {
                if (status.state === "ready") {
                    this.listener = undefined;
                    resolve(status);
                } else if (status.state === "failed") {
                    this.listener = undefined;
                    reject(
                        new PublishError(
                            "preview-failed",
                            "The app did not start for the phone",
                            {
                                reason: status.reason ?? "",
                            },
                            status.message
                        )
                    );
                }
            };
            signal.addEventListener("abort", () => reject(new PublishError("cancelled", "Stopped")), { once: true });
            this.listener = settle;
            if (this.last) {
                settle(this.last);
            }
        });
    }
}
