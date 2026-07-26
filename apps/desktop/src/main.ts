import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { ControlServer, EXPECTED_CODEX_VERSION } from "@codex-control/server";

interface DesktopSettings {
  tunnelProvider: "sakura-frp" | "cloudflare";
  tunnelUrl: string;
  encryptedTunnelToken: string;
  launchAtLogin: boolean;
  welcomeShown?: boolean;
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const startupLogPath = join(process.env.TEMP || process.cwd(), "codex-control-startup.log");
const startupTrace = (message: string): void => {
  try {
    appendFileSync(startupLogPath, `${new Date().toISOString()} pid=${process.pid} ${message}\n`, "utf8");
  } catch {
    // Startup diagnostics must never prevent the tray app from launching.
  }
};
startupTrace("module-loaded");
let tray: Tray | null = null;
let controlServer: ControlServer | null = null;
let serviceReady = false;
let localUrl = "http://127.0.0.1:4689";
let settingsWindow: BrowserWindow | null = null;
let pairingWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;
let latestSettings: DesktopSettings = { tunnelProvider: "sakura-frp", tunnelUrl: "", encryptedTunnelToken: "", launchAtLogin: true };

const hasSingleInstanceLock = app.requestSingleInstanceLock();
startupTrace(`single-instance-lock=${hasSingleInstanceLock}`);
if (!hasSingleInstanceLock) {
  // Do not continue into a never-resolving `whenReady()` after losing the
  // lock. This can happen briefly while an older installer-launched process
  // is shutting down and otherwise leaves a headless background process.
  app.quit();
} else {
  app.on("second-instance", () => void openControlWindow(false));
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => void controlServer?.stop());
  startupTrace("registering-app-ready-handler");
  void app.whenReady().then(initializeDesktop).catch((error) => {
    startupTrace(`app-ready-failed=${error instanceof Error ? error.message : String(error)}`);
    console.error("Codex Control failed before initialization", error);
  });
}

async function initializeDesktop(): Promise<void> {
  startupTrace("app-ready");
  app.setAppUserModelId("dev.codex-control.desktop");
  startupTrace("loading-settings");
  latestSettings = await loadSettings();
  startupTrace("settings-loaded");
  app.setLoginItemSettings({ openAtLogin: latestSettings.launchAtLogin, path: process.execPath });
  startupTrace("creating-tray");
  createTray();
  startupTrace("tray-created");
  registerIpc();
  if (!latestSettings.welcomeShown) {
    startupTrace("creating-starting-window");
    showStartingWindow();
    startupTrace("starting-window-created");
  }
  startupTrace("starting-service");
  void startService();
}

async function startService(): Promise<void> {
  try {
    const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : resolve(currentDir, "../../web/dist");
    controlServer = new ControlServer({
      dataDir: join(app.getPath("userData"), "service"),
      webRoot,
      secureCookies: app.isPackaged,
      autoDownloadBinaries: true,
      publicOrigin: latestSettings.tunnelUrl || null,
      externalTunnel: latestSettings.tunnelProvider === "sakura-frp",
      getTunnelToken: async () => decryptTunnelToken(latestSettings.encryptedTunnelToken),
      getTunnelUrl: async () => latestSettings.tunnelUrl || null,
      logger: true,
    });
    controlServer.events.subscribe(() => rebuildTrayMenu());
    localUrl = await controlServer.start();
    serviceReady = true;
    if (!latestSettings.welcomeShown) {
      latestSettings.welcomeShown = true;
      await saveSettings(latestSettings);
      void openControlWindow(true);
    }
  } catch (error) {
    console.error("Codex Control failed to start", error);
    startupTrace(`service-start-failed=${error instanceof Error ? error.message : String(error)}`);
    serviceReady = false;
    showStartupError(error);
  } finally {
    rebuildTrayMenu();
  }
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Codex Control");
  tray.on("double-click", () => void openControlWindow(false));
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const status = controlServer?.status;
  const devices = controlServer?.devices ?? [];
  const deviceMenu = devices.length
    ? devices.map((device) => ({
        label: `${device.name} · ${new Date(device.lastSeenAt).toLocaleDateString()}`,
        submenu: [{ label: "撤销访问", click: () => void controlServer?.revokeDevice(device.id).then(rebuildTrayMenu) }],
      }))
    : [{ label: "尚未配对设备", enabled: false }];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Codex: ${statusLabel(status?.codex)}`, enabled: false },
    { label: `Tunnel: ${statusLabel(status?.tunnel)}`, enabled: false },
    { type: "separator" },
    { label: "打开手机网站", click: () => void openMobileSite() },
    { label: "添加设备", click: () => void showPairing() },
    { label: "已配对设备", submenu: deviceMenu },
    { type: "separator" },
    { label: "配置公网访问（Sakura FRP / Cloudflare）", click: showSettings },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: latestSettings.launchAtLogin,
      click: (item) => void setLaunchAtLogin(item.checked),
    },
    { label: "导出诊断信息", click: () => void exportDiagnostics() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
}

async function showPairing(): Promise<void> {
  if (!controlServer) {
    await dialog.showMessageBox({ type: "warning", message: "本地服务仍在启动，请稍后重试。" });
    return;
  }
  const pairing = controlServer.createPairing();
  const baseUrl = pairing.url || localUrl;
  const pairingUrl = `${baseUrl.replace(/\/$/, "")}/#pair=${encodeURIComponent(pairing.token)}`;
  const qr = await QRCode.toDataURL(pairingUrl, { width: 320, margin: 1, color: { dark: "#111315", light: "#ffffff" } });
  pairingWindow?.close();
  pairingWindow = new BrowserWindow({
    width: 420,
    height: 570,
    resizable: false,
    title: "添加设备",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  pairingWindow.setMenuBarVisibility(false);
  await pairingWindow.loadURL(htmlDataUrl(pairingHtml(qr, pairing.code, pairing.expiresAt, Boolean(pairing.url))));
  pairingWindow.on("closed", () => { pairingWindow = null; });
}

function showSettings(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 500,
    resizable: false,
    title: "公网访问设置",
    webPreferences: {
      preload: join(currentDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  void settingsWindow.loadURL(htmlDataUrl(settingsHtml()));
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

function registerIpc(): void {
  ipcMain.handle("settings:load", () => ({
    tunnelProvider: latestSettings.tunnelProvider,
    tunnelUrl: latestSettings.tunnelUrl,
    hasTunnelToken: Boolean(latestSettings.encryptedTunnelToken),
    launchAtLogin: latestSettings.launchAtLogin,
  }));
  ipcMain.handle("settings:save", async (_event, input: { tunnelProvider?: "sakura-frp" | "cloudflare"; tunnelUrl?: string; tunnelToken?: string; launchAtLogin?: boolean }) => {
    const tunnelUrl = normalizeHttpsUrl(input.tunnelUrl ?? "");
    if (input.tunnelToken?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable");
      latestSettings.encryptedTunnelToken = safeStorage.encryptString(input.tunnelToken.trim()).toString("base64");
    }
    latestSettings.tunnelProvider = input.tunnelProvider ?? latestSettings.tunnelProvider;
    latestSettings.tunnelUrl = tunnelUrl;
    latestSettings.launchAtLogin = input.launchAtLogin ?? latestSettings.launchAtLogin;
    await saveSettings(latestSettings);
    app.setLoginItemSettings({ openAtLogin: latestSettings.launchAtLogin, path: process.execPath });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 400);
    return { ok: true };
  });
}

async function openMobileSite(): Promise<void> {
  await shell.openExternal(controlServer?.status.tunnelUrl || latestSettings.tunnelUrl || localUrl);
}

async function openControlWindow(firstLaunch: boolean): Promise<void> {
  if (!controlServer || !serviceReady) {
    if (!controlWindow || controlWindow.isDestroyed()) showStartingWindow();
    controlWindow?.show();
    controlWindow?.focus();
    return;
  }

  let url = localUrl;
  if (firstLaunch) {
    const pairing = controlServer.createPairing();
    url = `${localUrl}/#pair=${encodeURIComponent(pairing.token)}`;
  }
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
    await controlWindow.loadURL(url);
    return;
  }

  controlWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: "Codex Control",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  controlWindow.setMenuBarVisibility(false);
  controlWindow.on("closed", () => { controlWindow = null; });

  await controlWindow.loadURL(url);
  controlWindow.show();
}

function showStartingWindow(): void {
  if (controlWindow && !controlWindow.isDestroyed()) return;
  controlWindow = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 620,
    minHeight: 420,
    title: "Codex Control",
    backgroundColor: "#eef0f1",
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  controlWindow.setMenuBarVisibility(false);
  controlWindow.on("closed", () => { controlWindow = null; });
  void controlWindow.loadURL(htmlDataUrl(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${windowCss()}body{display:grid;place-items:center;height:100vh}main{max-width:520px}.loader{width:32px;height:32px;margin:22px auto;border:3px solid #c9d0cd;border-top-color:#286f54;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><main><div class="loader"></div><h1>Codex Control 正在启动</h1><p>首次启动需要准备 Codex 运行组件，可能需要一两分钟。完成后控制台会自动打开。</p></main>`)).then(() => controlWindow?.show());
}

function showStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!controlWindow || controlWindow.isDestroyed()) showStartingWindow();
  void controlWindow?.loadURL(htmlDataUrl(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${windowCss()}body{display:grid;place-items:center;height:100vh}main{max-width:580px}.error{margin:18px 0;padding:14px;text-align:left;color:#8e2929;background:#f7dddd;border:1px solid #e7b8b8;border-radius:6px;word-break:break-word}</style><main><h1>Codex Control 启动失败</h1><p>运行组件未能准备完成。请检查网络连接后退出托盘应用并重新启动。</p><div class="error">${escapeHtml(message)}</div></main>`)).then(() => {
    controlWindow?.show();
    controlWindow?.focus();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  latestSettings.launchAtLogin = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  await saveSettings(latestSettings);
  rebuildTrayMenu();
}

async function exportDiagnostics(): Promise<void> {
  const result = await dialog.showSaveDialog({
    title: "导出诊断信息",
    defaultPath: `codex-control-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return;
  const report = {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    expectedCodexVersion: EXPECTED_CODEX_VERSION,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    status: controlServer?.status ?? null,
    tunnelProvider: latestSettings.tunnelProvider,
    configuredTunnelUrl: redactHostname(latestSettings.tunnelUrl),
    hasTunnelToken: Boolean(latestSettings.encryptedTunnelToken),
    pairedDeviceCount: controlServer?.devices.length ?? 0,
  };
  await writeFile(result.filePath, JSON.stringify(report, null, 2), "utf8");
}

function settingsPath(): string {
  return join(app.getPath("userData"), "desktop-settings.json");
}

async function loadSettings(): Promise<DesktopSettings> {
  try {
    const saved = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<DesktopSettings>;
    return {
      ...latestSettings,
      ...saved,
      // Existing installations with a saved Cloudflare token keep their
      // previous behavior; new installations default to Sakura FRP mode.
      tunnelProvider: saved.tunnelProvider ?? (saved.encryptedTunnelToken ? "cloudflare" : latestSettings.tunnelProvider),
    };
  } catch {
    return latestSettings;
  }
}

async function saveSettings(settings: DesktopSettings): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function decryptTunnelToken(encrypted: string): string | null {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

function normalizeHttpsUrl(value: string): string {
  if (!value.trim()) return "";
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("访问地址必须使用 HTTPS");
  return url.origin;
}

function statusLabel(status: string | undefined): string {
  return ({ connected: "已连接", starting: "启动中", degraded: "部分可用", offline: "离线" } as Record<string, string>)[status ?? ""] ?? "未启动";
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="5" fill="#17201d"/><path d="M8 10h16v12H8z" fill="none" stroke="#fff" stroke-width="2"/><path d="m12 14-3 2 3 2m8-4 3 2-3 2" fill="none" stroke="#65c49c" stroke-width="2"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize({ width: 16, height: 16 });
}

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function pairingHtml(qr: string, code: string, expiresAt: string, remote: boolean): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${windowCss()}</style><main><h1>添加手机设备</h1><p>${remote ? "使用手机相机扫描二维码" : "Tunnel 尚未配置；二维码仅能在本机使用"}</p><img class="qr" src="${qr}" alt="配对二维码"><div class="code">${code}</div><p>也可以在手机配对页输入此一次性代码</p><small>有效期至 ${new Date(expiresAt).toLocaleTimeString()}</small></main>`;
}

function settingsHtml(): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>${windowCss()}</style><main><h1>公网访问设置</h1><p>本机服务固定监听 <code>http://127.0.0.1:4689</code>。Sakura FRP 请将公网 HTTPS 地址映射到该地址。</p><label>公网访问方式<select id="provider"><option value="sakura-frp">Sakura FRP（推荐，外部运行）</option><option value="cloudflare">Cloudflare Named Tunnel（应用管理）</option></select></label><label>HTTPS 公网地址<input id="url" placeholder="https://codex.example.com"></label><div id="token-row"><label>Tunnel token<input id="token" type="password" placeholder="留空则保留已有 token"></label></div><p id="hint" class="hint"></p><label class="check"><input id="launch" type="checkbox"> 开机自动启动</label><div id="error"></div><button id="save">保存并重启</button><script>const api=window.codexControlDesktop;const provider=document.getElementById('provider');const url=document.getElementById('url');const token=document.getElementById('token');const tokenRow=document.getElementById('token-row');const hint=document.getElementById('hint');const launch=document.getElementById('launch');function refresh(){const sakura=provider.value==='sakura-frp';tokenRow.style.display=sakura?'none':'block';hint.textContent=sakura?'请先在 Sakura FRP 客户端创建 HTTPS 隧道，将本机 4689 端口映射到公网，然后填入公网地址。':'应用会自动启动并管理 cloudflared，需填写 Cloudflare connector token。'}provider.onchange=refresh;api.loadSettings().then(s=>{provider.value=s.tunnelProvider||'sakura-frp';url.value=s.tunnelUrl;launch.checked=s.launchAtLogin;token.placeholder=s.hasTunnelToken?'已安全保存；留空则不修改':'粘贴 Tunnel token';refresh()});save.onclick=async()=>{save.disabled=true;error.textContent='';try{await api.saveSettings({tunnelProvider:provider.value,tunnelUrl:url.value,tunnelToken:token.value,launchAtLogin:launch.checked});save.textContent='正在重启...'}catch(e){error.textContent=e.message;save.disabled=false}}</script></main>`;
}

function windowCss(): string {
  return `*{box-sizing:border-box}body{margin:0;background:#eef0f1;color:#25292c;font:14px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0}main{width:100%;padding:28px 34px;text-align:center}h1{margin:0 0 8px;font-size:22px}p{margin:5px 0 16px;color:#687076}img.qr{width:300px;height:300px;border:1px solid #d6dadd}.code{margin:10px auto 2px;font:700 28px/1.2 Consolas;letter-spacing:4px}small{color:#80868a}label{display:block;margin:16px 0;text-align:left;font-weight:650}input,select{display:block;width:100%;height:40px;margin-top:6px;padding:0 10px;border:1px solid #bec5c9;border-radius:5px;background:#fff;font:inherit}.check{display:flex;gap:8px;align-items:center}.check input{display:inline;width:17px;height:17px;margin:0}button{width:100%;height:42px;color:white;background:#286f54;border:0;border-radius:5px;font:700 14px inherit;cursor:pointer}code{padding:2px 4px;background:#dfe3e5;border-radius:3px}#error{margin:8px 0;color:#a32f2f}.hint{min-height:40px;padding:10px;text-align:left;background:#e2e8e5;border-radius:5px}`;
}

function redactHostname(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname.replace(/^[^.]+/, "***")}`;
  } catch {
    return "invalid";
  }
}
