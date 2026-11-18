import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { Readable, Writable } from "stream";
import { createLogger } from "../../logger";
import { ProcessTree } from "../process/ProcessTree";

/** One screenshot of the running app. */
export interface AppShotRequest {
    /** page to open; must be a loopback http(s) URL */
    url: string;
    /** viewport size in CSS pixels (= the design board size) */
    width: number;
    height: number;
    /** pause after load before the shot */
    settleMs: number;
}

/** Headless browser taking screenshots of the generated app. */
export interface AppScreenshotter {
    /** Opens the page at the viewport size and returns a PNG of the viewport. */
    capture(request: AppShotRequest): Promise<Buffer>;
    /** Closes the browser (idempotent). */
    close(): Promise<void>;
}

/** Starts screenshotters; one per QA run. */
export interface AppScreenshotterFactory {
    open(): Promise<AppScreenshotter>;
}

/**
 * Error when no Chromium-based browser can be found or started.
 */
export class BrowserUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BrowserUnavailableError";
    }
}

/**
 * Finder of a Chromium-based browser on the host: `PENFORGE_QA_BROWSER`, then Chrome, Edge and
 * Chromium at their usual places (Windows, macOS) or in `PATH` (Linux and others).
 */
export class BrowserLocator {
    public static find(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
        const configured = env.PENFORGE_QA_BROWSER?.trim();
        if (configured) {
            return existsSync(configured) ? configured : null;
        }
        return BrowserLocator.candidates(env, platform).find((file) => existsSync(file)) ?? null;
    }

    private static candidates(env: NodeJS.ProcessEnv, platform: string): string[] {
        if (platform === "win32") {
            const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
                (root): root is string => !!root
            );
            const relative = [
                "Google\\Chrome\\Application\\chrome.exe",
                "Microsoft\\Edge\\Application\\msedge.exe",
                "Chromium\\Application\\chrome.exe",
            ];
            return relative.flatMap((file) => roots.map((root) => join(root, file)));
        }
        if (platform === "darwin") {
            return [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ];
        }
        const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
        const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
        return names.flatMap((name) => dirs.map((dir) => join(dir, name)));
    }
}

/** Pending CDP command. */
interface PendingCommand {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
}

/** Listener of a CDP event of one session. */
type EventListener = (params: any) => void;

/**
 * Headless Chrome / Edge driven over the DevTools protocol through a pipe
 * (`--remote-debugging-pipe`): no debugging port is opened, so no other program on the machine
 * can reach the browser. Only loopback pages are opened; the browser runs with a throw-away
 * profile that is deleted on {@link close}.
 */
export class ChromeScreenshotter implements AppScreenshotter {
    private static readonly logger = createLogger("ChromeScreenshotter");
    private static readonly LOAD_TIMEOUT_MS = 30_000;
    private static readonly COMMAND_TIMEOUT_MS = 30_000;
    private static readonly LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
    /** stops animations and the text caret, so two shots of the same page are equal */
    private static readonly FREEZE_CSS =
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
        "transition:none!important;caret-color:transparent!important}";

    private nextId = 1;
    private buffer = "";
    private closed = false;
    private readonly pending = new Map<number, PendingCommand>();
    private readonly listeners = new Map<string, Set<EventListener>>();

    private constructor(
        private readonly tree: ProcessTree,
        private readonly writer: Writable,
        reader: Readable,
        private readonly profileDir: string
    ) {
        reader.setEncoding("utf8");
        reader.on("data", (chunk: string) => this.receive(chunk));
        tree.child.once("exit", () => this.failAll(new BrowserUnavailableError("The browser closed")));
    }

    /**
     * Starts a headless browser.
     *
     * @param executable - browser to start; found with {@link BrowserLocator} when omitted
     * @throws BrowserUnavailableError when no browser is found or it does not start
     */
    public static async launch(executable = BrowserLocator.find()): Promise<ChromeScreenshotter> {
        if (!executable) {
            throw new BrowserUnavailableError(
                "No Chrome, Edge or Chromium found. Install one, or set PENFORGE_QA_BROWSER to its path."
            );
        }
        const profileDir = await mkdtemp(join(tmpdir(), "penforge-qa-"));
        const args = [
            "--headless=new",
            "--remote-debugging-pipe",
            `--user-data-dir=${profileDir}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-sync",
            "--hide-scrollbars",
            "--mute-audio",
            "--force-color-profile=srgb",
            "--force-device-scale-factor=1",
            "about:blank",
        ];
        const tree = new ProcessTree(
            { file: executable, args, windowsVerbatimArguments: false },
            { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
        );
        const writer = tree.child.stdio[3] as Writable | null;
        const reader = tree.child.stdio[4] as Readable | null;
        if (!writer || !reader) {
            await tree.kill();
            await rm(profileDir, { recursive: true, force: true }).catch(() => {});
            throw new BrowserUnavailableError("The browser could not be started");
        }
        const browser = new ChromeScreenshotter(tree, writer, reader, profileDir);
        try {
            await new Promise<void>((resolve, reject) => {
                tree.child.once("error", (error) => reject(new BrowserUnavailableError(error.message)));
                browser.send("Browser.getVersion").then(() => resolve(), reject);
            });
        } catch (error) {
            await browser.close();
            throw error instanceof BrowserUnavailableError ? error : new BrowserUnavailableError(String(error));
        }
        return browser;
    }

    public async capture(request: AppShotRequest): Promise<Buffer> {
        ChromeScreenshotter.checkUrl(request.url);
        const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
        try {
            await this.send("Page.enable", {}, sessionId);
            await this.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
            await this.send(
                "Emulation.setDeviceMetricsOverride",
                {
                    width: request.width,
                    height: request.height,
                    deviceScaleFactor: 1,
                    mobile: request.width < 600,
                },
                sessionId
            );
            const loaded = this.waitForLoad(sessionId);
            const navigation = await this.send("Page.navigate", { url: request.url }, sessionId);
            if (navigation?.errorText) {
                loaded.cancel();
                throw new Error(`The app page did not open: ${navigation.errorText}`);
            }
            loaded.setLoader(navigation?.loaderId);
            await loaded.done;
            await this.send(
                "Runtime.evaluate",
                {
                    expression:
                        "(async () => { const s = document.createElement('style');" +
                        `s.textContent = ${JSON.stringify(ChromeScreenshotter.FREEZE_CSS)};` +
                        "document.head.appendChild(s); window.scrollTo(0, 0);" +
                        "if (document.fonts) { await document.fonts.ready; } })()",
                    awaitPromise: true,
                },
                sessionId
            );
            await ChromeScreenshotter.sleep(request.settleMs);
            const shot = await this.send(
                "Page.captureScreenshot",
                {
                    format: "png",
                    clip: { x: 0, y: 0, width: request.width, height: request.height, scale: 1 },
                },
                sessionId
            );
            return Buffer.from(String(shot.data), "base64");
        } finally {
            await this.send("Target.closeTarget", { targetId }).catch(() => undefined);
        }
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await this.sendRaw("Browser.close").catch(() => undefined);
        this.failAll(new Error("The browser was closed"));
        await Promise.race([this.tree.waitForExit(), ChromeScreenshotter.sleep(3000)]);
        if (!this.tree.hasExited) {
            await this.tree.kill();
        }
        await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }

    /**
     * Refuses anything but http(s) pages on the loopback interface.
     */
    public static checkUrl(url: string): void {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`Not a valid app URL: ${url}`);
        }
        if (!["http:", "https:"].includes(parsed.protocol) || !ChromeScreenshotter.LOOPBACK.has(parsed.hostname)) {
            throw new Error(`Only pages of this machine can be checked, not ${parsed.origin}`);
        }
    }

    /**
     * Waits for the `networkIdle` lifecycle event of a navigation (or its `load` plus a moment,
     * for pages that keep a connection open, such as dev servers with hot reload). Events are
     * collected from the start, because they may arrive before `Page.navigate` answers with the
     * navigation's `loaderId`.
     */
    private waitForLoad(sessionId: string): {
        done: Promise<void>;
        setLoader: (loaderId: string | undefined) => void;
        cancel: () => void;
    } {
        const seen: { name: string; loaderId?: string }[] = [];
        let loader: string | null = null;
        let check = () => {};
        let cancel = () => {};
        const done = new Promise<void>((resolve, reject) => {
            let loadTimer: NodeJS.Timeout | undefined;
            const timeout = setTimeout(() => {
                finish();
                reject(new Error("The app page did not finish loading in time"));
            }, ChromeScreenshotter.LOAD_TIMEOUT_MS);
            const finish = () => {
                clearTimeout(timeout);
                clearTimeout(loadTimer);
                this.off(sessionId, "Page.lifecycleEvent", onLifecycle);
            };
            check = () => {
                if (loader === null) {
                    return;
                }
                const own = seen.filter((event) => !loader || event.loaderId === loader);
                if (own.some((event) => event.name === "networkIdle")) {
                    finish();
                    resolve();
                } else if (own.some((event) => event.name === "load") && !loadTimer) {
                    loadTimer = setTimeout(() => {
                        finish();
                        resolve();
                    }, 2000);
                }
            };
            const onLifecycle = (params: any) => {
                seen.push({ name: String(params?.name), loaderId: params?.loaderId });
                check();
            };
            cancel = () => {
                finish();
                resolve();
            };
            this.on(sessionId, "Page.lifecycleEvent", onLifecycle);
        });
        return {
            done,
            setLoader: (loaderId) => {
                loader = loaderId ?? "";
                check();
            },
            cancel: () => cancel(),
        };
    }

    private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
        if (this.closed) {
            return Promise.reject(new Error("The browser was closed"));
        }
        return this.sendRaw(method, params, sessionId);
    }

    private sendRaw(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`The browser did not answer ${method}`));
            }, ChromeScreenshotter.COMMAND_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (result) => {
                    clearTimeout(timer);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            const message = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
            this.writer.write(`${message}\0`, (error) => {
                if (error) {
                    this.pending.get(id)?.reject(error);
                    this.pending.delete(id);
                }
            });
        });
    }

    private receive(chunk: string): void {
        this.buffer += chunk;
        let end = this.buffer.indexOf("\0");
        while (end >= 0) {
            const raw = this.buffer.slice(0, end);
            this.buffer = this.buffer.slice(end + 1);
            end = this.buffer.indexOf("\0");
            let message: any;
            try {
                message = JSON.parse(raw);
            } catch {
                ChromeScreenshotter.logger.warn("Unreadable message from the browser");
                continue;
            }
            if (typeof message.id === "number") {
                const pending = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    pending?.reject(new Error(String(message.error.message ?? "Browser error")));
                } else {
                    pending?.resolve(message.result ?? {});
                }
            } else if (typeof message.method === "string") {
                const key = `${message.sessionId ?? ""}:${message.method}`;
                for (const listener of [...(this.listeners.get(key) ?? [])]) {
                    listener(message.params);
                }
            }
        }
    }

    private on(sessionId: string, method: string, listener: EventListener): void {
        const key = `${sessionId}:${method}`;
        let set = this.listeners.get(key);
        if (!set) {
            set = new Set();
            this.listeners.set(key, set);
        }
        set.add(listener);
    }

    private off(sessionId: string, method: string, listener: EventListener): void {
        this.listeners.get(`${sessionId}:${method}`)?.delete(listener);
    }

    private failAll(error: Error): void {
        for (const pending of [...this.pending.values()]) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private static sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/** Factory of {@link ChromeScreenshotter}s. */
export class ChromeScreenshotterFactory implements AppScreenshotterFactory {
    constructor(private readonly executable?: string) {}

    public open(): Promise<AppScreenshotter> {
        return ChromeScreenshotter.launch(this.executable ?? BrowserLocator.find());
    }
}
