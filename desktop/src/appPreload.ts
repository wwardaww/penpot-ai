import { contextBridge, ipcRenderer } from "electron";

/**
 * API of the Penpot window (served by the gateway on the app origin): the native folder dialog
 * that the W38 create-project dialog uses to link a Game UI or Existing project. The main process
 * answers only requests from the app origin.
 */
contextBridge.exposeInMainWorld("penforgeDesktopBridge", {
    chooseFolder: (): Promise<string | undefined> => ipcRenderer.invoke("app:choose-folder"),
});
