// Fake dev server for the process manager tests.
//
// Usage: node fakeDevServer.mjs <mode> [arg]
//   serve              listen on $PORT and announce the URL
//   announce <port>    ignore $PORT, listen on <port> and announce it
//   crash              exit with code 1 at once
//   crash-once <file>  exit with code 1 when <file> does not exist (and create it), else serve
//   never              print output but never listen
//   tree <file>        start a grandchild that serves on $PORT, write its pid to <file>, stay alive
//   flaky              serve on $PORT, then exit with code 1 after 400 ms
//   env <file>         write the environment as JSON to <file>, then serve
//   child              (internal) serve on $PORT; used by `tree`
//   open               serve on $PORT without a host (all interfaces)
//   open-all / open-v6 serve on $PORT on 0.0.0.0 / ::
//   escape             start a grandchild without NODE_OPTIONS that serves on all interfaces
//   late-escape        serve on loopback, then after 300 ms hand the port to such a grandchild
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const [mode, arg] = process.argv.slice(2);

function serve(port, host = "127.0.0.1") {
    const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>fake app</title><h1>fake app</h1>");
    });
    const announce = () => console.log(`  \u001b[32mLocal:\u001b[0m   http://localhost:${port}/`);
    if (host === null) {
        server.listen(port, announce);
    } else {
        server.listen(port, host, announce);
    }
    return server;
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
    case "flaky":
        serve(port);
        setTimeout(() => process.exit(1), 400);
        break;
    case "env":
        writeFileSync(arg, JSON.stringify(process.env));
        serve(port);
        break;
    case "never":
        console.log("starting, but never listening");
        setInterval(() => {}, 1000);
        break;
    case "open":
        serve(port, arg ?? null);
        break;
    case "open-all":
        serve(port, "0.0.0.0");
        break;
    case "open-v6":
        serve(port, "::");
        break;
    case "escape": {
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        spawn(process.execPath, [fileURLToPath(import.meta.url), "open", "0.0.0.0"], { stdio: "inherit", env });
        setInterval(() => {}, 1000);
        break;
    }
    case "late-escape": {
        const server = serve(port);
        setTimeout(() => {
            server.close(() => {
                const env = { ...process.env };
                delete env.NODE_OPTIONS;
                spawn(process.execPath, [fileURLToPath(import.meta.url), "open", "0.0.0.0"], { stdio: "inherit", env });
            });
            server.closeAllConnections();
        }, 300);
        setInterval(() => {}, 1000);
        break;
    }
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
