import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle, MonitorSmartphone } from "lucide-react";
import { pair } from "../lib/api";

export function Pairing({ onPaired }: { onPaired: () => void }) {
  const [credential, setCredential] = useState(readPairingFragment());
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (credential.length > 20) void submit();
    // The URL fragment is intentionally consumed only in-browser.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (!credential.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await pair({ token: credential.trim(), deviceName });
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      onPaired();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "配对失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pairing-shell">
      <section className="pairing-panel" aria-labelledby="pairing-title">
        <div className="brand-mark"><MonitorSmartphone size={28} /></div>
        <h1 id="pairing-title">连接到 Codex Control</h1>
        <p>在 PC 托盘菜单中点击“添加设备”，扫描二维码或输入一次性配对码。</p>
        <label>
          设备名称
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} autoComplete="off" />
        </label>
        <label>
          配对码
          <input value={credential} onChange={(event) => setCredential(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="9 位配对码" />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <button className="primary-command" onClick={() => void submit()} disabled={busy || !credential.trim()}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <KeyRound size={18} />}
          配对设备
        </button>
      </section>
    </main>
  );
}

function readPairingFragment(): string {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  return fragment.get("pair") ?? fragment.get("code") ?? "";
}

function defaultDeviceName(): string {
  const platform = navigator.userAgent.match(/iPhone|iPad|Android/i)?.[0] ?? "Mobile";
  return `${platform} browser`;
}

