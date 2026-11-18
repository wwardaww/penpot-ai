"use strict";

const LABELS = {
  postgres: "Database",
  "media-processor": "Image processing",
  backend: "Design server",
  daemon: "AI assistant",
};

const STATES = {
  pending: "waiting",
  starting: "starting…",
  ready: "ready",
  restarting: "restarting…",
  failed: "failed",
  stopped: "stopped",
};

window.penforgeDesktop.onStatus((status) => {
  if (!Array.isArray(status)) {
    document.getElementById("message").textContent = status.message;
    return;
  }
  const list = document.getElementById("services");
  list.replaceChildren();
  for (const service of status) {
    const item = document.createElement("li");
    item.className = service.state;
    const name = document.createElement("span");
    name.textContent = LABELS[service.name] || service.name;
    const state = document.createElement("span");
    state.textContent = STATES[service.state] || service.state;
    item.append(name, state);
    list.append(item);
  }
});
