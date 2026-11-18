import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { postgresReady, waitUntil } from "../health/probes";
import { exe } from "../config/layout";
import { isAlive } from "../process/treeKill";
import { exitedReason, type ServiceContext, type ServiceDefinition } from "./context";

export const DB_USER = "penpot";
/** The backend uses the database initdb creates; the bundle has no createdb/psql. */
export const DB_NAME = "postgres";

function bin(ctx: ServiceContext, name: string): string {
    return join(ctx.runtime.postgresBin, exe(name, ctx.platform));
}

/** Runs a short command to completion; rejects with its output on a non-zero exit. */
export function runToEnd(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`${command} exited with ${code}:\n${output}`));
            }
        });
    });
}

/** PID recorded in `postmaster.pid`, or undefined. */
export function postmasterPid(pgdata: string): number | undefined {
    const file = join(pgdata, "postmaster.pid");
    if (!existsSync(file)) {
        return undefined;
    }
    const pid = Number.parseInt(readFileSync(file, "utf8").split(/\r?\n/)[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function postgresArgs(ctx: ServiceContext): string[] {
    return [
        "-D", ctx.data.pgdata,
        "-p", String(ctx.ports.postgres),
        "-c", "listen_addresses=127.0.0.1",
        "-c", "unix_socket_directories=",
        "-c", "max_connections=60",
        "-c", "shared_buffers=64MB",
        "-c", "logging_collector=off",
    ];
}

/**
 * Bundled PostgreSQL. First start runs `initdb` (scram auth, random password, C locale);
 * a server left over by a crashed shell is stopped before the new start.
 */
export const postgresService: ServiceDefinition = {
    name: "postgres",
    critical: true,

    async prepare(ctx) {
        const env = { ...ctx.baseEnv, LC_ALL: "C" };
        if (!existsSync(join(ctx.data.pgdata, "PG_VERSION"))) {
            mkdirSync(ctx.data.tmp, { recursive: true });
            rmSync(ctx.data.pgdata, { recursive: true, force: true });
            const pwfile = join(ctx.data.tmp, `pw-${process.pid}.txt`);
            writeFileSync(pwfile, ctx.state.postgresPassword, { mode: 0o600 });
            try {
                await runToEnd(bin(ctx, "initdb"), [
                    "-D", ctx.data.pgdata,
                    "-U", DB_USER,
                    `--pwfile=${pwfile}`,
                    "-A", "scram-sha-256",
                    "-E", "UTF8",
                    "--no-locale",
                ], env);
            } finally {
                rmSync(pwfile, { force: true });
            }
        }
        const stale = postmasterPid(ctx.data.pgdata);
        if (stale !== undefined && isAlive(stale)) {
            await runToEnd(bin(ctx, "pg_ctl"), ["stop", "-D", ctx.data.pgdata, "-m", "fast", "-w", "-t", "60"], env).catch(() => undefined);
        }
    },

    spec(ctx) {
        return {
            name: "postgres",
            command: bin(ctx, "postgres"),
            args: postgresArgs(ctx),
            env: { ...ctx.baseEnv, LC_ALL: "C" },
            cwd: ctx.data.root,
            logFile: join(ctx.data.logs, "postgres.log"),
        };
    },

    async ready(ctx, proc) {
        await waitUntil("postgres", () => postgresReady(ctx.ports.postgres, "127.0.0.1", DB_USER), {
            timeoutMs: 60_000,
            abort: () => {
                const reason = exitedReason(proc)();
                if (reason && /administrative permissions/i.test(reason)) {
                    return "PostgreSQL refuses to run with administrator rights: start Penforge as a normal user";
                }
                return reason;
            },
        });
    },

    stopOptions(ctx) {
        return {
            timeoutMs: 30_000,
            graceful: async () => {
                await runToEnd(bin(ctx, "pg_ctl"), ["stop", "-D", ctx.data.pgdata, "-m", "fast", "-w", "-t", "25"], ctx.baseEnv, 30_000);
            },
        };
    },
};
