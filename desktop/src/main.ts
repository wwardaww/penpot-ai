import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from "electron";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localLogin } from "./auth/localLogin";
import { boot, projectsDirOf, type RunningApp } from "./boot";
import { detectClaude, loginShellPath, openLoginTerminal, type ClaudeStatus } from "./claude/detectClaude";
import { DesktopState, type Persona } from "./config/DesktopState";
import { dataLayout } from "./config/layout";
import { shutdownChecks, smokeChecks } from "./smoke";
import type { ServiceStatus } from "./supervisor/Supervisor";

const SMOKE = process.argv.includes("--smoke");
const SOURCE_URL = "https://github.com/wwardaww/penpot-ai";
const CLAUDE_SETUP_URL = "https://docs.claude.com/en/docs/claude-code/setup";

let running: RunningApp | undefined;
let mainWindow: BrowserWindow | undefined;
let shuttingDown: Promise<void> | undefined;

function runtimeRoot(): string {
    if (process.env.PENFORGE_DESKTOP_RUNTIME) {
        return process.env.PENFORGE_DESKTOP_RUNTIME;
    }
    return app.isPackaged ? join(process.resourcesPath, "runtime") : join(app.getAppPath(), "build", "runtime");
}

function dataRoot(): string {
    return process.env.PENFORGE_DESKTOP_DATA || app.getPath("userData");
}

function rendererFile(name: string): string {
    return join(app.getAppPath(), "renderer", name);
}

function preloadFile(): string {
    return join(app.getAppPath(), "dist", "preload.js");
}

/** Environment of the children; on macOS with the login shell's PATH (Finder apps get a bare one). */
async function childBaseEnv(): Promise<NodeJS.ProcessEnv> {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const shellPath = await loginShellPath(env).catch(() => undefined);
    if (shellPath) {
        env.PATH = shellPath;
    }
    return env;
}

// --- windows

function createSplash(): BrowserWindow {
    const win = new BrowserWindow({
        width: 520,
        height: 380,
        resizable: false,
        frame: true,
        show: true,
        title: "Penforge",
        webPreferences: { preload: preloadFile(), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    void win.loadFile(rendererFile("splash.html"));
    return win;
}

function sendStatus(win: BrowserWindow | undefined, statuses: ServiceStatus[] | { message: string }): void {
    if (win && !win.isDestroyed()) {
        win.webContents.send("penforge:status", statuses);
    }
}

function isSameOrigin(url: string, origin: string): boolean {
    try {
        return new URL(url).origin === origin;
    } catch {
        return false;
    }
}

function openExternal(url: string): void {
    if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
    }
}

function guardWindow(win: BrowserWindow, origin: string): void {
    win.webContents.on("will-navigate", (event, url) => {
        if (!isSameOrigin(url, origin)) {
            event.preventDefault();
            openExternal(url);
        }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isSameOrigin(url, origin) || url === "about:blank") {
            // detached AI chat (W10) and frame preview popups talk to their opener
            return {
                action: "allow",
                overrideBrowserWindowOptions: {
                    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
                },
            };
        }
        openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("did-create-window", (child) => guardWindow(child, origin));
}

function restrictPermissions(origin: string): void {
    const allowed = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen", "pointerLock"]);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
        callback(allowed.has(permission) && isSameOrigin(contents.getURL(), origin));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
        return allowed.has(permission) && requestingOrigin === origin;
    });
}

/** Logs the local profile in and puts the session cookie into the window's cookie jar. */
async function signIn(app_: RunningApp): Promise<void> {
    const { ports, origin, state } = app_.context;
    const login = await localLogin(ports.backend, state.localLoginSecret, {
        fullname: state.wizard.fullname,
        persona: state.wizard.persona,
    });
    for (const cookie of login.cookies) {
        await session.defaultSession.cookies.set({
            url: origin,
            name: cookie.name,
            value: cookie.value,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            sameSite: "lax",
            expirationDate: cookie.expirationDate,
        });
    }
}

function createMainWindow(app_: RunningApp): BrowserWindow {
    const { origin } = app_.context;
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false,
        title: "Penforge",
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    guardWindow(win, origin);
    // a logout lands on the login page, which has no form in the desktop app: sign in again
    win.webContents.on("did-navigate-in-page", (_event, url) => {
        if (/#\/auth\/login/.test(url)) {
            void signIn(app_).then(() => win.loadURL(`${origin}/`));
        }
    });
    win.once("ready-to-show", () => win.show());
    void win.loadURL(`${origin}/`);
    return win;
}

// --- first-run wizard

interface WizardResult {
    fullname?: string;
    persona: Persona;
    projectsDir: string;
}

async function runWizard(state: DesktopState, env: NodeJS.ProcessEnv): Promise<void> {
    const win = new BrowserWindow({
        width: 720,
        height: 640,
        title: "Welcome to Penforge",
        webPreferences: { preload: preloadFile(), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    let claude: ClaudeStatus | undefined;

    const handlers: Record<string, (...args: unknown[]) => unknown> = {
        "wizard:defaults": () => ({ projectsDir: join(homedir(), "Penforge"), persona: "designer" }),
        "wizard:detect-claude": async () => (claude = await detectClaude(env, homedir())),
        "wizard:open-login": () => {
            if (claude?.path) {
                openLoginTerminal(claude.path);
            }
        },
        "wizard:install-help": () => openExternal(CLAUDE_SETUP_URL),
        "wizard:choose-folder": async () => {
            const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
            return result.canceled ? undefined : result.filePaths[0];
        },
    };
    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, (_event, ...args) => handler(...args));
    }
    try {
        await new Promise<void>((resolve, reject) => {
            ipcMain.handleOnce("wizard:finish", (_event, result: WizardResult) => {
                state.update((d) => {
                    d.wizard = {
                        done: true,
                        fullname: result.fullname?.trim() || undefined,
                        persona: result.persona === "developer" ? "developer" : "designer",
                        projectsDir: result.projectsDir || join(homedir(), "Penforge"),
                    };
                });
                mkdirSync(projectsDirOf(state), { recursive: true });
                resolve();
            });
            win.on("closed", () => reject(new Error("wizard closed")));
            void win.loadFile(rendererFile("wizard.html"));
        });
    } finally {
        for (const channel of [...Object.keys(handlers), "wizard:finish"]) {
            ipcMain.removeHandler(channel);
        }
        if (!win.isDestroyed()) {
            win.close();
        }
    }
}

// --- menu

async function backupData(): Promise<void> {
    if (!running) {
        return;
    }
    const target = await dialog.showOpenDialog({ title: "Back up Penforge data to…", properties: ["openDirectory", "createDirectory"] });
    if (target.canceled || !target.filePaths[0]) {
        return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(target.filePaths[0], `Penforge-backup-${stamp}`);
    const data = running.context.data;
    // a cold copy: the database must be stopped while its files are copied
    await running.stop();
    mkdirSync(dest, { recursive: true });
    cpSync(data.pgdata, join(dest, "pgdata"), { recursive: true });
    if (existsSync(data.assets)) {
        cpSync(data.assets, join(dest, "assets"), { recursive: true });
    }
    cpSync(data.stateFile, join(dest, "desktop.json"));
    await dialog.showMessageBox({ message: "Backup done", detail: `Saved in ${dest}. Penforge restarts now.` });
    app.relaunch();
    app.exit(0);
}

function buildMenu(): Menu {
    const template: MenuItemConstructorOptions[] = [
        ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
        {
            label: "File",
            submenu: [
                { label: "Open projects folder", click: () => running && void shell.openPath(projectsDirOf(running.state)) },
                { label: "Open logs folder", click: () => void shell.openPath(dataLayout(dataRoot()).logs) },
                { label: "Back up data…", click: () => void backupData() },
                { type: "separator" },
                { role: "quit" },
            ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
        {
            role: "help",
            submenu: [
                { label: "Claude Code setup", click: () => openExternal(CLAUDE_SETUP_URL) },
                { label: "Source code (MPL-2.0)", click: () => openExternal(SOURCE_URL) },
                {
                    label: "About Penforge",
                    click: () =>
                        void dialog.showMessageBox({
                            title: "About Penforge",
                            message: `Penforge ${app.getVersion()}`,
                            detail:
                                `Penpot fork with the Penforge AI studio. Penpot is MPL-2.0; source: ${SOURCE_URL}.\n` +
                                `Bundled: Electron ${process.versions.electron}, PostgreSQL (PostgreSQL License), ` +
                                "Azul Zulu JRE (GPLv2 + Classpath Exception), sharp/libvips (Apache-2.0 / LGPL-3.0). " +
                                "License texts are in the app's resources folder.",
                        }),
                },
            ],
        },
    ];
    return Menu.buildFromTemplate(template);
}

// --- lifecycle

function shutdown(code = 0): Promise<void> {
    shuttingDown ??= (async () => {
        for (const win of BrowserWindow.getAllWindows()) {
            win.hide();
        }
        await running?.stop().catch(() => undefined);
        app.exit(code);
    })();
    return shuttingDown;
}

async function runSmoke(): Promise<void> {
    const started = Date.now();
    let exitCode = 1;
    try {
        running = await boot({
            runtimeRoot: runtimeRoot(),
            dataRoot: dataRoot(),
            nodeExecutable: process.execPath,
            nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
            baseEnv: await childBaseEnv(),
            appVersion: app.getVersion(),
        });
        const bootMs = Date.now() - started;
        const checks = await smokeChecks(running);
        const memory = process.memoryUsage().rss;
        await running.stop();
        checks.push(...(await shutdownChecks(running)));
        exitCode = checks.every((check) => check.ok) ? 0 : 2;
        console.log(JSON.stringify({ smoke: exitCode === 0 ? "ok" : "failed", bootMs, shellRssBytes: memory, warnings: running.warnings, checks }, null, 2));
    } catch (error) {
        console.log(JSON.stringify({ smoke: "failed", error: (error as Error).message }, null, 2));
        await running?.stop().catch(() => undefined);
    }
    app.exit(exitCode);
}

async function main(): Promise<void> {
    if (!SMOKE && !app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });
    app.on("before-quit", (event) => {
        if (running && !shuttingDown) {
            event.preventDefault();
            void shutdown();
        }
    });
    app.on("window-all-closed", () => void shutdown());
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => void shutdown());
    }

    await app.whenReady();
    if (SMOKE) {
        await runSmoke();
        return;
    }
    Menu.setApplicationMenu(buildMenu());

    const env = await childBaseEnv();
    const data = dataLayout(dataRoot());
    const state = DesktopState.load(data.stateFile);
    // the splash opens first: closing the wizard must not leave the app without a window
    // (that would fire `window-all-closed` and quit)
    const splash = createSplash();
    if (!state.data.wizard.done) {
        try {
            await runWizard(state, env);
        } catch {
            app.exit(0);
            return;
        }
    }

    try {
        const claude = await detectClaude(env, homedir());
        running = await boot({
            runtimeRoot: runtimeRoot(),
            dataRoot: data.root,
            nodeExecutable: process.execPath,
            nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
            baseEnv: env,
            appVersion: app.getVersion(),
            claudePath: claude.path,
            onStatus: (statuses) => sendStatus(splash, statuses),
        });
        restrictPermissions(running.context.origin);
        sendStatus(splash, { message: "Signing in…" });
        await signIn(running);
        running.supervisor.on("failed", (status: ServiceStatus) => {
            void dialog.showMessageBox({
                type: "error",
                message: `${status.name} stopped working`,
                detail: `${status.detail ?? ""}\n\nLog: ${status.logFile ?? data.logs}`,
            });
        });
        mainWindow = createMainWindow(running);
        mainWindow.once("show", () => !splash.isDestroyed() && splash.close());
        if (running.warnings.length > 0) {
            void dialog.showMessageBox({ type: "warning", message: "Penforge started with problems", detail: running.warnings.join("\n") });
        }
        if (!claude.found || !claude.loggedIn) {
            void dialog.showMessageBox({
                type: "info",
                message: claude.found ? "Claude Code is not logged in" : "Claude Code is not installed",
                detail: "Design works without it. AI features need the `claude` CLI logged in: File menu → Help → Claude Code setup.",
            });
        }
    } catch (error) {
        const result = await dialog.showMessageBox({
            type: "error",
            message: "Penforge could not start",
            detail: `${(error as Error).message}\n\nLogs: ${data.logs}`,
            buttons: ["Open logs folder", "Quit"],
        });
        if (result.response === 0) {
            await shell.openPath(data.logs);
        }
        await shutdown(1);
    }
}

void main();
