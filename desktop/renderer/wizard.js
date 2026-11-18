"use strict";

const api = window.penforgeDesktop.wizard;
const $ = (id) => document.getElementById(id);

async function checkClaude() {
  const status = $("claude-status");
  status.className = "status";
  status.textContent = "Looking for the claude command…";
  const claude = await api.detectClaude();
  $("claude-login").hidden = !claude.found || claude.loggedIn;
  $("claude-install").hidden = claude.found;
  if (!claude.found) {
    status.className = "status bad";
    status.textContent = "Not found. Design works without it; install Claude Code to use the AI.";
  } else if (!claude.loggedIn) {
    status.className = "status bad";
    status.textContent = `Found ${claude.version || "claude"}, but not logged in.`;
  } else {
    status.className = "status ok";
    status.textContent = `Ready: ${claude.version || "claude"} is logged in.`;
  }
}

async function init() {
  const defaults = await api.defaults();
  $("projects").value = defaults.projectsDir;
  $("choose").addEventListener("click", async () => {
    const folder = await api.chooseFolder();
    if (folder) {
      $("projects").value = folder;
    }
  });
  $("claude-check").addEventListener("click", checkClaude);
  $("claude-login").addEventListener("click", () => api.openLogin());
  $("claude-install").addEventListener("click", () => api.installHelp());
  $("finish").addEventListener("click", async () => {
    $("finish").disabled = true;
    const persona = document.querySelector('input[name="persona"]:checked').value;
    await api.finish({ fullname: $("fullname").value, persona, projectsDir: $("projects").value });
  });
  await checkClaude();
}

init();
