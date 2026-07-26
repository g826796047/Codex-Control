import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("codexControlDesktop", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings: { tunnelProvider: "sakura-frp" | "cloudflare"; tunnelUrl: string; tunnelToken: string; launchAtLogin: boolean }) => ipcRenderer.invoke("settings:save", settings),
});
