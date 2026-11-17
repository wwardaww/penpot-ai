// Fake dev server for the process manager tests.
//
// Usage: node fakeDevServer.mjs <mode> [arg]
//   serve              listen on $PORT and announce the URL
//   announce <port>    ignore $PORT, listen on <port> and announce it
//   crash              exit with code 1 at once
//   crash-once <file>  exit with code 1 when <file> does not exist (and create it), else serve
//   never              print output but never listen
//   tree <file>        start a grandchild that serves on $PORT, write its pid to <file>, stay alive
//   child              (internal) serve on $PORT; used by `tree`
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const [mode, arg] = process.argv.slice(2);

function serve(port) {
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>fake app</title><h1>fake app</h1>");
    });
    server.listen(port, "127.0.0.1", () => {
        console.log(`  \u001b[32mLocal:\u001b[0m   http://localhost:${port}/`);
    });
}

const port = Number(process.env.PORT);

switch (mode) {
    case "serve":
    case "child":
        serve(port);
        break;
    case "announce":
        serve(Number(arg));
        break;
    case "crash":
        console.error("boom");
        process.exit(1);
        break;
    case "crash-once":
        if (existsSync(arg)) {
            serve(port);
        } else {
            writeFileSync(arg, "crashed");
            console.error("first start crashes");
            process.exit(1);
        }
        break;
    case "never":
        console.log("starting, but never listening");
        setInterval(() => {}, 1000);
        break;
    case "tree": {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
            stdio: "inherit",
            env: process.env,
        });
        writeFileSync(arg, String(child.pid));
        setInterval(() => {}, 1000);
        break;
    }
    default:
        console.error(`unknown mode ${mode}`);
        process.exit(2);
}
