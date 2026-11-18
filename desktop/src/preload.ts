import { contextBridge, ipcRenderer } from "electron";

/** API of the splash and wizard pages (local files, never the Penpot origin). */
contextBridge.exposeInMainWorld("penforgeDesktop", {
    onStatus: (callback: (status: unknown) => void) => {
        ipcRenderer.on("penforge:status", (_event, status) => callback(status));
    },
    wizard: {
        defaults: () => ipcRenderer.invoke("wizard:defaults"),
        detectClaude: () => ipcRenderer.invoke("wizard:detect-claude"),
        openLogin: () => ipcRenderer.invoke("wizard:open-login"),
        installHelp: () => ipcRenderer.invoke("wizard:install-help"),
        chooseFolder: () => ipcRenderer.invoke("wizard:choose-folder"),
        finish: (answers: unknown) => ipcRenderer.invoke("wizard:finish", answers),
    },
});
