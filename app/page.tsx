"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  DeviceProfile,
  DeviceProfileInput,
  formatHex,
  parseAddress,
  parseProfile,
  validateWritePlan,
} from "@/lib/profile";
import { SwireBus } from "@/lib/swire";
import { bytesToHex, Tlsr826xFlash } from "@/lib/tlsr826x";
import { getSerialApi, WebSerialTransport } from "@/lib/web-serial";
import genericProfileJson from "@/public/profiles/tlsr826x-generic-512k.json";

type Connection = {
  transport: WebSerialTransport;
  bus: SwireBus;
  flash: Tlsr826xFlash;
};

const bundled = [
  { path: "/profiles/tlsr826x-generic-512k.json", label: "TLSR826x · Generic 512 KiB" },
  { path: "/profiles/es-b01cw-bank-a.json", label: "ENDO ES-B01CW · Bank A" },
];

const initialProfile = parseProfile(genericProfileJson);

function download(data: Uint8Array, filename: string) {
  const blob = new Blob([data as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function sha256(data: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));
}

export default function Home() {
  const [profile, setProfile] = useState<DeviceProfile | null>(initialProfile);
  const [profilePath, setProfilePath] = useState(bundled[0].path);
  const [profileError, setProfileError] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const [firmware, setFirmware] = useState<Uint8Array | null>(null);
  const [firmwareName, setFirmwareName] = useState("");
  const [firmwareHash, setFirmwareHash] = useState("");
  const [writeOffset, setWriteOffset] = useState(formatHex(initialProfile.write.defaultOffset));
  const [readOffset, setReadOffset] = useState("0x000000");
  const [readSize, setReadSize] = useState(formatHex(initialProfile.flash.size));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([`Loaded profile: ${initialProfile.name}`]);
  const [probe, setProbe] = useState("");
  const [activationBase, setActivationBase] = useState<number | null>(null);

  const log = (message: string, completed?: number, total?: number) => {
    setLogs((current) => [...current.slice(-119), message]);
    if (completed !== undefined && total) setProgress(Math.round((completed / total) * 100));
  };

  const loadProfile = async (path: string) => {
    setProfileError("");
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`profile returned HTTP ${response.status}`);
      const parsed = parseProfile(await response.json());
      setProfile(parsed);
      setWriteOffset(formatHex(parsed.write.defaultOffset));
      setReadOffset("0x000000");
      setReadSize(formatHex(parsed.flash.size));
      setActivationBase(null);
      log(`Loaded profile: ${parsed.name}`);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    return () => {
      void connectionRef.current?.transport.close();
    };
  }, []);

  const writePlan = useMemo(() => {
    if (!profile || !firmware) return null;
    try {
      const offset = parseAddress(writeOffset, "write offset");
      const plan = validateWritePlan(profile, offset, firmware);
      return { ok: true as const, offset, ...plan };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [profile, firmware, writeOffset]);

  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setProfileError("");
    try {
      const input = JSON.parse(await file.text()) as DeviceProfileInput;
      const parsed = parseProfile(input);
      setProfile(parsed);
      setProfilePath("custom");
      setWriteOffset(formatHex(parsed.write.defaultOffset));
      setReadSize(formatHex(parsed.flash.size));
      setActivationBase(null);
      log(`Imported profile: ${parsed.name}`);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : String(error));
    } finally {
      event.target.value = "";
    }
  };

  const chooseFirmware = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFirmware(bytes);
    setFirmwareName(file.name);
    setFirmwareHash(await sha256(bytes));
    setActivationBase(null);
    log(`Selected firmware: ${file.name} · ${bytes.length} bytes`);
  };

  const connect = async () => {
    if (!profile) return;
    const serial = getSerialApi();
    if (!serial) {
      setProfileError("Web Serial is not available in this browser. Use a current desktop browser with Web Serial support.");
      return;
    }
    setBusy(true);
    setProgress(0);
    let transport: WebSerialTransport | null = null;
    try {
      const port = await serial.requestPort();
      transport = new WebSerialTransport(
        port,
        profile.transport.baudRate,
        profile.transport.readTimeoutMs,
        profile.transport.highSpeedChunkBytes,
      );
      await transport.open();
      const bus = new SwireBus(transport);
      log(`Halting CPU for ${profile.cpu.stopDurationMs} ms…`);
      await bus.haltCpu(profile.cpu.stopRegister, profile.cpu.stopValue, profile.cpu.stopDurationMs);
      const divider = await bus.setSpeed(profile.chip.clockHz);
      const flash = new Tlsr826xFlash(bus, profile);
      const jedec = bytesToHex(await flash.readJedec());
      if (!jedec || jedec === "000000" || jedec === "ffffff") throw new Error(`invalid JEDEC ID: ${jedec}`);
      if (profile.flash.jedecIds.length && !profile.flash.jedecIds.includes(jedec)) {
        throw new Error(`JEDEC ID ${jedec} is not permitted by this profile`);
      }
      const next = { transport, bus, flash };
      connectionRef.current = next;
      setConnection(next);
      setProbe(`JEDEC ${jedec.match(/../g)?.join(" ")} · SWire divider ${divider}`);
      log(`Connected · JEDEC ${jedec} · divider ${divider}`);
      transport = null;
    } catch (error) {
      log(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
      await transport?.close().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    setBusy(true);
    try {
      await connection.transport.close();
    } finally {
      connectionRef.current = null;
      setConnection(null);
      setProbe("");
      setBusy(false);
      log("Serial port disconnected");
    }
  };

  const runRead = async () => {
    if (!connection || !profile) return;
    setBusy(true);
    setProgress(0);
    try {
      const offset = parseAddress(readOffset, "read offset");
      const size = parseAddress(readSize, "read size");
      const bytes = await connection.flash.verifiedRead(offset, size, log);
      const digest = await sha256(bytes);
      download(bytes, `${profile.id}-${formatHex(offset).slice(2)}-${formatHex(size).slice(2)}-${digest.slice(0, 12)}.bin`);
      log(`Read complete · SHA-256 ${digest}`);
      setProgress(100);
    } catch (error) {
      log(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const runWrite = async () => {
    if (!connection || !profile || !firmware || !writePlan?.ok) return;
    const approved = window.confirm(
      `This will back up, erase, write, and verify ${formatHex(writePlan.eraseStart)}–${formatHex(writePlan.eraseEnd)}. Keep power and wiring stable. Continue?`,
    );
    if (!approved) return;
    setBusy(true);
    setProgress(0);
    setActivationBase(null);
    try {
      const result = await connection.flash.writeVerified(writePlan.offset, firmware, log);
      const backupHash = await sha256(result.backup);
      download(
        result.backup,
        `${profile.id}-prewrite-${formatHex(result.eraseStart).slice(2)}-${backupHash.slice(0, 12)}.bin`,
      );
      log(`Write is byte-exact · pre-write backup SHA-256 ${backupHash}`);
      setProgress(100);
      setActivationBase(profile.write.activationPatch ? writePlan.offset : null);
    } catch (error) {
      log(`Write stopped safely: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!connection || !profile?.write.activationPatch || activationBase === null) return;
    if (!window.confirm(`Apply final activation patch “${profile.write.activationPatch.label}”?`)) return;
    setBusy(true);
    try {
      await connection.flash.activate(activationBase, log);
      setActivationBase(null);
      log("Activation patch verified. Firmware is ready to boot.");
    } catch (error) {
      log(`Activation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const resetCpu = async () => {
    if (!connection || !profile) return;
    setBusy(true);
    try {
      await connection.bus.resetCpu(profile.cpu.resetRegister, profile.cpu.resetValue);
      log("CPU reset sent");
    } catch (error) {
      log(`Reset failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Telink Web SWire home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Telink Web SWire</span>
        </a>
        <div className={`connection-pill ${connection ? "online" : ""}`}>
          <span aria-hidden="true" /> {connection ? "Connected" : "Offline"}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">LOCAL-FIRST FLASH TOOL</p>
          <h1>Read. Write. Verify.<br /><em>Directly in your browser.</em></h1>
          <p className="lede">
            A cautious Web Serial programmer for Telink TLSR826x devices. Firmware and flash contents stay on this computer.
          </p>
        </div>
        <div className="signal-card" aria-label="SWire connection diagram">
          <div><span>USB-UART TX</span><b /></div>
          <div className="resistor">1.8 kΩ</div>
          <div><b /><span>TARGET SWS</span></div>
          <small>RX joins SWS · common GND · target at 3.3 V</small>
        </div>
      </section>

      <section className="workspace" aria-label="SWire programmer">
        <div className="controls">
          <article className="panel profile-panel">
            <div className="step">01</div>
            <div className="panel-head">
              <div><p className="kicker">TARGET CONTRACT</p><h2>Device profile</h2></div>
              <label className="file-button subtle">
                Import JSON
                <input type="file" accept="application/json,.json" onChange={importProfile} disabled={busy || Boolean(connection)} />
              </label>
            </div>
            <label className="field-label" htmlFor="profile">Bundled profile</label>
            <select
              id="profile"
              value={profilePath}
              disabled={busy || Boolean(connection)}
              onChange={(event) => {
                const path = event.target.value;
                setProfilePath(path);
                if (path !== "custom") void loadProfile(path);
              }}
            >
              {bundled.map((item) => <option key={item.path} value={item.path}>{item.label}</option>)}
              {profilePath === "custom" && <option value="custom">Imported profile</option>}
            </select>
            {profileError && <p className="error" role="alert">{profileError}</p>}
            {profile && (
              <div className="profile-summary">
                <div><span>Flash</span><strong>{profile.flash.size / 1024} KiB</strong></div>
                <div><span>Sector / page</span><strong>{profile.flash.sectorSize / 1024} KiB / {profile.flash.pageSize} B</strong></div>
                <div><span>Write mode</span><strong>{profile.write.enabled ? formatHex(profile.write.defaultOffset) : "READ ONLY"}</strong></div>
                <div><span>Clock</span><strong>{profile.chip.clockHz / 1_000_000} MHz</strong></div>
              </div>
            )}
            <button className="primary connect" onClick={connect} disabled={!profile || busy || Boolean(connection)}>
              {connection ? "Port connected" : busy ? "Working…" : "Choose serial port"}
            </button>
            {probe && <p className="probe">{probe}</p>}
          </article>

          <article className="panel firmware-panel">
            <div className="step">02</div>
            <div className="panel-head">
              <div><p className="kicker">LOCAL INPUT</p><h2>Firmware image</h2></div>
              <label className="file-button">
                Choose .bin
                <input type="file" accept=".bin,application/octet-stream" onChange={chooseFirmware} disabled={busy} />
              </label>
            </div>
            <div className={`dropzone ${firmware ? "has-file" : ""}`}>
              {firmware ? (
                <><strong>{firmwareName}</strong><span>{firmware.length.toLocaleString()} bytes</span><code>{firmwareHash}</code></>
              ) : (
                <><strong>No firmware selected</strong><span>The file is read locally and never uploaded.</span></>
              )}
            </div>
            <label className="field-label" htmlFor="write-offset">Write offset</label>
            <input id="write-offset" className="mono-input" value={writeOffset} onChange={(event) => setWriteOffset(event.target.value)} disabled={busy} />
            {writePlan && (
              writePlan.ok ? (
                <p className="plan-ok">Sector plan {formatHex(writePlan.eraseStart)} → {formatHex(writePlan.eraseEnd)} · allowed</p>
              ) : <p className="error" role="alert">{writePlan.error}</p>
            )}
          </article>

          <article className="panel action-panel">
            <div className="step">03</div>
            <div className="panel-head"><div><p className="kicker">OPERATIONS</p><h2>Read or program</h2></div></div>
            <div className="range-grid">
              <label><span>Read offset</span><input className="mono-input" value={readOffset} onChange={(event) => setReadOffset(event.target.value)} disabled={busy} /></label>
              <label><span>Read size</span><input className="mono-input" value={readSize} onChange={(event) => setReadSize(event.target.value)} disabled={busy} /></label>
            </div>
            <div className="action-row">
              <button className="secondary" onClick={runRead} disabled={!connection || busy}>Read & download</button>
              <button className="danger" onClick={runWrite} disabled={!connection || !firmware || !writePlan?.ok || busy}>Backup + write + verify</button>
            </div>
            {profile?.write.activationPatch && (
              <button className="activation" onClick={activate} disabled={!connection || activationBase === null || busy}>
                Finalize: {profile.write.activationPatch.label}
              </button>
            )}
            <div className="session-actions">
              <button onClick={resetCpu} disabled={!connection || busy}>Reset CPU</button>
              <button onClick={disconnect} disabled={!connection || busy}>Disconnect</button>
            </div>
          </article>
        </div>

        <aside className="console-panel">
          <div className="console-head"><span>SESSION LOG</span><b>{progress}%</b></div>
          <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
          <div className="console" role="log" aria-live="polite">
            {logs.map((entry, index) => <div key={`${index}-${entry}`}><span>{String(index + 1).padStart(3, "0")}</span>{entry}</div>)}
          </div>
          <div className="safety-note">
            <strong>Power-loss safe workflow</strong>
            <p>Affected sectors are backed up before erase. Every programmed page is read back before success is reported. Activation remains a separate final write.</p>
          </div>
        </aside>
      </section>

      <footer>
        <span>Open source · no telemetry · no firmware uploads</span>
        <a href="https://github.com/nunnun/telink-web-swire">GitHub</a>
      </footer>
    </main>
  );
}
