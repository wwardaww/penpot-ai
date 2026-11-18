// Fake child service for the supervisor tests.
//   FAKE_PORT          answer HTTP 200 on this loopback port (omit: no server)
//   FAKE_READY_DELAY   wait this many ms before listening
//   FAKE_CRASH_AFTER   exit with code 3 after this many ms
//   FAKE_GRANDCHILD=1  start a long-lived child and print `GRANDCHILD_PID=<pid>`
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number(process.env.FAKE_PORT || 0);
const delay = Number(process.env.FAKE_READY_DELAY || 0);
const crashAfter = Number(process.env.FAKE_CRASH_AFTER || 0);

if (process.env.FAKE_GRANDCHILD === "1") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(`GRANDCHILD_PID=${child.pid}`);
}

setTimeout(() => {
    if (port > 0) {
        createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        }).listen(port, "127.0.0.1", () => console.log(`listening ${port}`));
    }
}, delay);

if (crashAfter > 0) {
    setTimeout(() => process.exit(3), crashAfter);
}

setInterval(() => {}, 1000);
