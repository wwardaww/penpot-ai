import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { exe, runtimeLayout } from "../config/layout";
import { postgresReady } from "../health/probes";
import { randomFreePort } from "../net/ports";
import { Supervisor } from "../supervisor/Supervisor";
import { fakeContext, tempDir } from "../testing/helpers";
import { postgresService, postmasterPid } from "./postgres";

// Runs against the real binaries staged by `scripts/fetch-runtime.mjs`; skipped without them.
const RUNTIME = join(__dirname, "..", "..", "build", "runtime");
const available = existsSync(join(RUNTIME, "postgres", "bin", exe("pg_ctl")));

describe("bundled PostgreSQL", { skip: !available && "run scripts/fetch-runtime.mjs first" }, () => {
    const temp = tempDir();
    after(() => temp.cleanup());

    it("initialises, starts, answers and stops without leftovers", { timeout: 180_000 }, async () => {
        const port = await randomFreePort();
        const context = { ...fakeContext(temp.dir, { postgres: port }), runtime: runtimeLayout(RUNTIME) };
        const supervisor = new Supervisor({ context, services: [postgresService] });

        await supervisor.start();
        assert.equal(supervisor.statuses()[0]!.state, "ready");
        assert.equal(await postgresReady(port), true);
        assert.ok(existsSync(join(context.data.pgdata, "PG_VERSION")));
        assert.ok(postmasterPid(context.data.pgdata));

        await supervisor.stop();
        assert.deepEqual(supervisor.leftovers(), []);
        assert.equal(await postgresReady(port), false);
        assert.equal(postmasterPid(context.data.pgdata), undefined, "clean shutdown removes postmaster.pid");

        // second start reuses the data folder (no initdb)
        await supervisor.start();
        assert.equal(await postgresReady(port), true);
        await supervisor.stop();
    });
});
