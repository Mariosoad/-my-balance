/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import React, { useEffect, useRef, useState } from "react";

// —— Tipos Web Serial mínimos ——
declare global {
  interface SerialPort {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
  }
  interface SerialOptions {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: "none" | "even" | "odd";
    bufferSize?: number;
    flowControl?: "none" | "hardware";
  }
  interface Navigator {
    serial: {
      requestPort(): Promise<SerialPort>;
      getPorts(): Promise<SerialPort[]>;
      onconnect: (e: any) => void;
      ondisconnect: (e: any) => void;
    };
  }
}
type SerialPortLike = SerialPort & {
  setSignals?: (signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void>;
};

const supportsWebSerial = typeof navigator !== "undefined" && "serial" in navigator as any;

// —— Parámetros de auto-detección ——
const BAUDS = [1200, 2400, 4800, 9600, 19200] as const;
const SETUPS = [
  { dataBits: 8 as const, parity: "none" as const, stopBits: 1 as const, name: "8N1" },
  { dataBits: 7 as const, parity: "even" as const, stopBits: 1 as const, name: "7E1" },
];
const DELIMS = ["\r", "\r\n", "\n"] as const;
const PROBE_MS = 1800; // escucha por combinación

const weightRegex = /([+\-]?\d{1,6}(?:[.,]\d{1,3})?)/;
function parseWeight(raw: string): string | null {
  const m = raw.trim().match(weightRegex);
  return m ? m[1].replace(",", ".") : null;
}
function makeLineTransformer(delimiter = "\r") {
  let buffer = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split(delimiter);
      buffer = parts.pop() ?? "";
      for (const p of parts) controller.enqueue(p);
    },
    flush(controller) { if (buffer) controller.enqueue(buffer); }
  });
}

type DetectedConfig = {
  baudRate: number;
  dataBits: 7 | 8;
  parity: "none" | "even";
  stopBits: 1;
  delimiter: "\r" | "\r\n" | "\n";
  name: string;
};

export default function ScaleAutoDetectAuto() {
  const [status, setStatus] = useState<string>(supportsWebSerial ? "Inicializando…" : "Web Serial no soportado");
  const [active, setActive] = useState<boolean>(false);
  const [weight, setWeight] = useState<string>("-");
  const [rawLine, setRawLine] = useState<string>("-");
  const [configLabel, setConfigLabel] = useState<string>("-");
  const [hint, setHint] = useState<string>("");

  const [log, setLog] = useState<string[]>([]);
  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const currentConfigRef = useRef<DetectedConfig | null>(null);

  async function openWithConfig(
    port: SerialPortLike,
    baudRate: number,
    dataBits: 7 | 8,
    parity: "none" | "even",
    stopBits: 1
  ) {
    try { readerRef.current?.releaseLock(); } catch {}
    try { await port.close?.(); } catch {}
    await port.open({ baudRate, dataBits, parity, stopBits, flowControl: "none" });
    if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  }

  async function probeOnce(port: SerialPortLike, cfg: DetectedConfig) {
    try {
      await openWithConfig(port, cfg.baudRate, cfg.dataBits, cfg.parity, cfg.stopBits);
      const decoder = new TextDecoderStream("ascii", { fatal: false, ignoreBOM: true });
      const lined = port.readable!.pipeThrough(decoder as any).pipeThrough(makeLineTransformer(cfg.delimiter));
      const reader = lined.getReader();
      const endAt = Date.now() + PROBE_MS;

      while (Date.now() < endAt) {
        const { value, done } = await reader.read();
        if (done) break;
        if (typeof value !== "string") continue;
        const raw = value.trim();
        if (!raw) continue;
        const parsed = parseWeight(raw);
        if (parsed) {
          reader.releaseLock();
          return { ok: true, sample: parsed, raw };
        }
      }
      reader.releaseLock();
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }

  async function autoDetect(port: SerialPortLike): Promise<DetectedConfig | null> {
    for (const b of BAUDS) {
      for (const s of SETUPS) {
        for (const d of DELIMS) {
          const cfg: DetectedConfig = {
            baudRate: b, dataBits: s.dataBits, parity: s.parity, stopBits: 1, delimiter: d,
            name: `${b} ${s.name} ${d === "\r" ? "CR" : d === "\r\n" ? "CRLF" : "LF"}`
          };
          setStatus(`Probando ${cfg.name}…`);
          const r = await probeOnce(port, cfg);
          if (r.ok) {
            setRawLine(r.raw!); setWeight(r.sample!);
            setLog(p => [`✔ Detectado ${cfg.name} | RAW='${r.raw}' Peso=${r.sample}`, ...p].slice(0, 80));
            return cfg;
          }
        }
      }
    }
    return null;
  }

  async function startReading(port: SerialPortLike, cfg: DetectedConfig) {
    await openWithConfig(port, cfg.baudRate, cfg.dataBits, cfg.parity, cfg.stopBits);
    const decoder = new TextDecoderStream("ascii", { fatal: false, ignoreBOM: true });
    const lined = port.readable!.pipeThrough(decoder as any).pipeThrough(makeLineTransformer(cfg.delimiter));
    const reader = lined.getReader();
    readerRef.current = reader;

    keepReadingRef.current = true;
    setActive(true);
    setStatus("Activo (leyendo)");
    setConfigLabel(cfg.name);

    (async () => {
      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (typeof value !== "string") continue;
        const raw = value.trim();
        if (!raw) continue;
        setRawLine(raw);
        const parsed = parseWeight(raw);
        if (parsed) setWeight(parsed);
      }
    })().catch(e => setLog(p => [`Error lectura: ${String(e)}`, ...p]));
  }

  async function tryAutoConnectWithGrantedPorts() {
    setStatus("Buscando puertos permitidos…");
    const ports = await navigator.serial.getPorts();
    if (!ports || ports.length === 0) {
      setStatus("Permiso requerido");
      setHint("Haz clic o presiona cualquier tecla para autorizar el puerto.");
      // un solo gesto para solicitar permiso
      const once = async () => {
        try {
          setStatus("Solicitando permiso…");
          const port = await navigator.serial.requestPort();
          portRef.current = port as SerialPortLike;
          setHint("");
          setStatus("Auto-detectando…");
          const cfg = await autoDetect(portRef.current);
          if (!cfg) { setStatus("No se detectó configuración"); setActive(false); return; }
          currentConfigRef.current = cfg;
          await startReading(portRef.current, cfg);
        } catch (e: any) {
          setStatus(`Error: ${e?.message ?? e}`);
        } finally {
          window.removeEventListener("click", once);
          window.removeEventListener("keydown", once);
        }
      };
      window.addEventListener("click", once, { once: true });
      window.addEventListener("keydown", once, { once: true });
      return;
    }

    // Si ya hay puertos con permiso, probamos cada uno automáticamente.
    setStatus("Intentando autoconectar…");
    for (const p of ports) {
      try {
        const port = p as SerialPortLike;
        portRef.current = port;
        const cfg = await autoDetect(port);
        if (cfg) {
          currentConfigRef.current = cfg;
          await startReading(port, cfg);
          return;
        }
      } catch {/* probar siguiente */}
    }
    setStatus("No se detectó configuración en puertos permitidos");
  }

  async function cleanup() {
    keepReadingRef.current = false;
    try { readerRef.current?.releaseLock(); } catch {}
    try { await portRef.current?.close?.(); } catch {}
    portRef.current = null;
    setActive(false);
  }

  useEffect(() => {
    if (!supportsWebSerial) return;

    // Autoconectar al cargar
    tryAutoConnectWithGrantedPorts();

    // Autoconectar si enchufan la balanza luego
    const onConnect = async () => {
      if (active) return;
      tryAutoConnectWithGrantedPorts();
    };
    const onDisconnect = async () => {
      setStatus("Desconectado");
      cleanup();
    };
    (navigator.serial as any).onconnect = onConnect;
    (navigator.serial as any).ondisconnect = onDisconnect;

    return () => { cleanup(); (navigator.serial as any).onconnect = null; (navigator.serial as any).ondisconnect = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "system-ui, Arial" }}>
      <h1>Lectura Balanza</h1>
      <div style={{ padding: 12, border: "1px solid #ddd", alignItems: 'left', justifyContent: 'left', borderRadius: 8, marginBottom: 12, display: "flex", flexDirection: 'column', gap: 12, width: '600px' }}>
        <div><strong>Estado:</strong> {status}</div>
        <div><strong>Config:</strong> {configLabel}</div>
      </div>
      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 12, display: "flex", flexDirection: 'column', gap: 12, alignItems: "left", width: '600px' }}>
        <div><strong>Balanza:</strong> <span style={{ color: active ? "#0a7" : "#c33", fontWeight: 700, fontSize: 22 }}>{active ? "ACTIVO" : "INACTIVO"}</span></div>
      </div>

      {hint && (
        <div style={{ padding: 12, color: 'red', textAlign: 'center', border: "1px dashed red", borderRadius: 8, marginBottom: 16 }}>
          {hint}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Peso</div>
          <div style={{ fontSize: 44, fontWeight: 800 }}>{weight}</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Último RAW: <code>{rawLine}</code></div>
        </div>
        <pre style={{ height: 180, overflow: "auto", background: "#0a0a0a", color: "#c3f3c3", padding: 12, borderRadius: 8, margin: 0 }}>
          {log.join("\n")}
        </pre>
      </div>
    </div>
  );
}
