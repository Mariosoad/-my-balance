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
    getInfo?: () => { usbVendorId?: number; usbProductId?: number };
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
      requestPort(opts?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPort>;
      getPorts(): Promise<SerialPort[]>;
      addEventListener(type: "connect" | "disconnect", listener: any): void;
      removeEventListener(type: "connect" | "disconnect", listener: any): void;
    };
  }
}
type SerialPortLike = SerialPort & {
  setSignals?: (signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void>;
};

const supportsWebSerial = typeof navigator !== "undefined" && "serial" in navigator as any;

// —— Parámetros de auto-detección (afinados a tu equipo) ——
const BAUDS = [1200] as const;
const SETUPS = [
  { dataBits: 7 as const, parity: "none" as const, stopBits: 1 as const, name: "7N1" },
  { dataBits: 8 as const, parity: "none" as const, stopBits: 1 as const, name: "8N1" }, // por si acaso
];
const DELIMS = ["\r"] as const; // fin de línea CR
const PROBE_MS = 1600;          // escucha por combinación

// —— Utilidades ——
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
function hex(buf: Uint8Array) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join(" ");
}
async function writeBytes(port: SerialPort, data: Uint8Array) {
  const writer = port.writable!.getWriter();
  await writer.write(data);
  writer.releaseLock();
}
async function writeToken(port: SerialPort, text: string) {
  await writeBytes(port, new TextEncoder().encode(text));
}
async function readSomeBytes(port: SerialPort, millis = 200): Promise<Uint8Array> {
  const reader = port.readable!.getReader();
  const chunks: number[] = [];
  const deadline = Date.now() + millis;
  try {
    while (Date.now() < deadline) {
      const timeLeft = deadline - Date.now();
      const oneRead = reader.read();
      const timeout = new Promise<{ value?: Uint8Array; done?: boolean }>(res =>
        setTimeout(() => res({ value: undefined, done: false }), Math.max(1, timeLeft))
      );
      const { value, done } = await Promise.race([oneRead, timeout]);
      if (done) break;
      if (value && value.length) chunks.push(...value);
      await new Promise(r => setTimeout(r, 5));
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(chunks);
}

// —— Tipos ——
type DetectedConfig = {
  baudRate: number;
  dataBits: 7 | 8;
  parity: "none" | "even";
  stopBits: 1;
  delimiter: "\r" | "\r\n" | "\n";
  name: string;
};

export default function ScaleAuto() {
  const [status, setStatus]   = useState<string>(supportsWebSerial ? "Inicializando…" : "Web Serial no soportado");
  const [active, setActive]   = useState<boolean>(false);
  const [weight, setWeight]   = useState<string>("-");
  const [rawLine, setRawLine] = useState<string>("-");
  const [configLabel, setConfigLabel] = useState<string>("-");
  const [hint, setHint]       = useState<string>("");

  const [log, setLog] = useState<string[]>([]);
  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const keepReadingRef = useRef<boolean>(false);

  // ——— Apertura robusta ———
  async function openWithConfig(
    port: SerialPortLike,
    baudRate: number,
    dataBits: 7 | 8,
    parity: "none" | "even",
    stopBits: 1
  ) {
    try { readerRef.current?.releaseLock(); } catch {}
    try { await port.close?.(); } catch {}
    await new Promise(r => setTimeout(r, 60));
    try {
      await port.open({ baudRate, dataBits, parity, stopBits, flowControl: "none" });
      if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setLog(p => [`[openWithConfig] ${msg}`, ...p].slice(0, 120));
      setStatus(`Error abriendo puerto: ${msg}`);
      throw e;
    }
    await new Promise(r => setTimeout(r, 40));
  }

  // ——— Autodetección ———
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
          return { ok: true as const, sample: parsed, raw };
        }
      }
      reader.releaseLock();
      return { ok: false as const };
    } catch (e: any) {
      setLog(p => [`[probeOnce] ${cfg.name} → ${String(e?.message ?? e)}`, ...p].slice(0, 120));
      return { ok: false as const };
    }
  }

  async function autoDetect(port: SerialPortLike): Promise<DetectedConfig | null> {
    for (const b of BAUDS) {
      for (const s of SETUPS) {
        for (const d of DELIMS) {
          const cfg: DetectedConfig = { baudRate: b, dataBits: s.dataBits, parity: s.parity, stopBits: 1, delimiter: d, name: `${b} ${s.name} CR` };
          setStatus(`Probando ${cfg.name}…`);
          const r = await probeOnce(port, cfg);
          if (r.ok) {
            setRawLine(r.raw!);
            setWeight(r.sample!);
            setLog(p => [`✔ Detectado ${cfg.name} | RAW='${r.raw}' Peso=${r.sample}`, ...p].slice(0, 120));
            return cfg;
          }
        }
      }
    }
    return null;
    }

  // ——— Loopback fuerte (manda varios tokens) ———
  async function loopbackTest(port: SerialPortLike): Promise<boolean> {
    await openWithConfig(port, 9600, 8, "none", 1);
    if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });

    const token = `LBK${Math.floor(Math.random()*1e6)}`;
    // manda 3 veces para asegurarnos
    for (let i = 0; i < 3; i++) {
      await writeToken(port, token + "\r");
      const bytes = await readSomeBytes(port, 250);
      if (bytes.length) {
        setLog(p => [`[LOOPBACK RX HEX] ${hex(bytes)}`, ...p].slice(0, 120));
        const enc = new TextEncoder().encode(token);
        if (bytes.join(",").includes(enc.join(","))) return true;
      } else {
        setLog(p => [`[LOOPBACK] sin bytes en intento ${i+1}`, ...p].slice(0, 120));
      }
      await new Promise(r => setTimeout(r, 80));
    }
    return false;
  }

  // ——— Lectura continua ———
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
    })().catch(e => setLog(p => [`[read loop] ${String(e)}`, ...p].slice(0, 120)));
  }

  // ——— Flujo principal ———
  async function tryAutoConnectWithGrantedPorts() {
    setStatus("Buscando puertos permitidos…");
    let ports: SerialPort[] = [];
    try {
      ports = await navigator.serial.getPorts();
    } catch (e: any) {
      setStatus(`Error getPorts: ${String(e?.message ?? e)}`);
      return;
    }

    if (!ports || ports.length === 0) {
      setStatus("Permiso requerido");
      setHint("Haz clic o presiona cualquier tecla para autorizar el puerto (COM1).");
      const once = async () => {
        try {
          setStatus("Solicitando permiso…");
          const port = await navigator.serial.requestPort(); // aquí el usuario elige COM1
          portRef.current = port as SerialPortLike;
          setHint("");

          // 1) autodetección
          setStatus("Auto-detectando…");
          const cfg = await autoDetect(portRef.current);
          if (cfg) { await startReading(portRef.current, cfg); return; }

          // 2) loopback si no hay datos
          setStatus("Sin datos de balanza. Probando loopback…");
          const ok = await loopbackTest(portRef.current);
          if (ok) {
            setStatus("Loopback detectado (eco OK). Puerto operativo.");
            setActive(true);
            setConfigLabel("Loopback @9600");
            setRawLine("ECO OK");
            setWeight("-");
            setLog(p => ["[LOOPBACK] Eco OK. Conecta la balanza para lectura real.", ...p].slice(0,120));
            return;
          }
          setStatus("No se detectó balanza ni loopback tras autorizar el puerto.");
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

    // Ya hay puertos con permiso → probarlos todos
    setStatus("Intentando autoconectar…");
    for (const p of ports) {
      try {
        const port = p as SerialPortLike;
        portRef.current = port;

        // 1) autodetección
        const cfg = await autoDetect(port);
        if (cfg) { await startReading(port, cfg); return; }

        // 2) loopback
        setStatus("Sin datos de balanza. Probando loopback…");
        const ok = await loopbackTest(port);
        if (ok) {
          setStatus("Loopback detectado (eco OK). Puerto operativo.");
          setActive(true);
          setConfigLabel("Loopback @9600");
          setRawLine("ECO OK");
          setWeight("-");
          setLog(p => ["[LOOPBACK] Eco OK. Conecta la balanza para lectura real.", ...p].slice(0,120));
          return;
        }
      } catch (e: any) {
        setLog(p => [`[tryAutoConnect] ${String(e?.message ?? e)}`, ...p].slice(0, 120));
      }
    }
    setStatus("No se detectó balanza ni loopback en puertos permitidos.");
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
    tryAutoConnectWithGrantedPorts();

    const connectHandler = () => { if (!active) tryAutoConnectWithGrantedPorts(); };
    const disconnectHandler = () => { setStatus("Desconectado"); cleanup(); };

    navigator.serial.addEventListener("connect", connectHandler as any);
    navigator.serial.addEventListener("disconnect", disconnectHandler as any);

    return () => {
      cleanup();
      navigator.serial.removeEventListener("connect", connectHandler as any);
      navigator.serial.removeEventListener("disconnect", disconnectHandler as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 1580, margin: "40px auto", fontFamily: "system-ui, Arial" }}>
      <h1>Lectura Balanza</h1>

      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 12 }}>
        <div><strong>Estado:</strong> {status}</div>
        <div><strong>Config:</strong> {configLabel}</div>
        <div><strong>Balanza:</strong> <span style={{ color: active ? "#0a7" : "#c33", fontWeight: 700 }}>{active ? "ACTIVO" : "INACTIVO"}</span></div>
      </div>

      {hint && (
        <div style={{ padding: 12, color: '#b00', textAlign: 'center', border: "1px dashed #b00", borderRadius: 8, marginBottom: 16 }}>
          {hint}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Peso</div>
          <div style={{ fontSize: 44, fontWeight: 800 }}>{weight}</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Último RAW: <code>{rawLine}</code></div>
        </div>
        <pre style={{ height: 220, overflow: "auto", background: "#0a0a0a", color: "#c3f3c3", padding: 12, borderRadius: 8, margin: 0 }}>
          {log.join("\n")}
        </pre>
      </div>
    </div>
  );
}
