/* eslint-disable @typescript-eslint/prefer-as-const */
/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import React, { useEffect, useRef, useState } from "react";

/* ==== Tipos mínimos Web Serial (TS) ==== */
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

const supportsWebSerial = typeof navigator !== "undefined" && "serial" in (navigator as any);

/* =====================================================================================
   Config La Torre
   - Arrancamos con Opción 1 (7N1).
   - Para probar otra, comentá la activa y descomentá la que quieras.
===================================================================================== */
const BAUD = 1200;

/** ---------------- Opción 1: 7N1 (recomendada para descartar ParityError) -------- */
const DATABITS: 7 | 8 = 7;
const PARITY: "none" | "even" | "odd" = "none";
const STOPBITS: 1 | 2 = 1;
const DELIM: string = "\r"; // CR

/** ---------------- Opción 2: 8N1 ----------------------------------------------- **/
// const DATABITS: 7 | 8 = 8;
// const PARITY: "none" | "even" | "odd" = "none";
// const STOPBITS: 1 | 2 = 1;
// const DELIM = "\r";

/** ---------------- Opción 3: 7E1 con CRLF ------------------------------------- **/
// const DATABITS: 7 | 8 = 7;
// const PARITY: "none" | "even" | "odd" = "even";
// const STOPBITS: 1 | 2 = 1;
// const DELIM = "\r\n";

/* ==== Utils ==== */
function makeLineTransformer(delimiter = "\r") {
  let buffer = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split(delimiter);
      buffer = parts.pop() ?? "";
      for (const p of parts) controller.enqueue(p);
    },
    flush(controller) {
      if (buffer) controller.enqueue(buffer);
    }
  });
}
function hex(buf: Uint8Array) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join(" ");
}
function modeStr() {
  const p = PARITY === "none" ? "N" : PARITY === "even" ? "E" : "O";
  return `${DATABITS}${p}${STOPBITS}`;
}

/* ==== Parser específico La Torre ==== */
/** Ejemplo crudo: "D025500"  ->  25.500 kg */
function parseLaTorre(rawIn: string): { ok: boolean; raw: string; kg?: number } {
  const raw = rawIn.trim();
  const m = raw.match(/^D(\d{6})$/i);
  if (!m) return { ok: false, raw };
  const grams = Number(m[1]); // 025500
  if (!Number.isFinite(grams)) return { ok: false, raw };
  return { ok: true, raw, kg: grams / 1000 }; // kg con 3 decimales
}

/* ==== Componente ==== */
export default function LatorreReader() {
  const [status, setStatus]     = useState<string>(supportsWebSerial ? "Listo para conectar" : "Web Serial no soportado");
  const [weight, setWeight]     = useState<string>("-");   // kg
  const [rawLine, setRawLine]   = useState<string>("-");
  const [log, setLog]           = useState<string[]>([]);
  const [portInfo, setPortInfo] = useState<string>("—");

  const portRef   = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const keepRef   = useRef<boolean>(false);

  async function openPort(port: SerialPortLike) {
    try { readerRef.current?.releaseLock(); } catch {}
    try { await port.close?.(); } catch {}
    await new Promise(r => setTimeout(r, 50));

    await port.open({
      baudRate: BAUD,
      dataBits: DATABITS,
      parity: PARITY,
      stopBits: STOPBITS,
      flowControl: "none"
    });
    // Muchas balanzas necesitan DTR/RTS en true
    if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await new Promise(r => setTimeout(r, 40));
  }

  function describePort(p: SerialPort) {
    try {
      const info = (p.getInfo?.() ?? {}) as any;
      const toHex = (n: number) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(4, "0");
      const vid = info.usbVendorId ? `VID ${toHex(info.usbVendorId)}` : "";
      const pid = info.usbProductId ? `PID ${toHex(info.usbProductId)}` : "";
      return [vid, pid].filter(Boolean).join(" ");
    } catch { return "—"; }
  }

  async function connect() {
    try {
      if (!supportsWebSerial) throw new Error("Navegador sin Web Serial");

      setStatus("Selecciona el puerto (La Torre)...");
      const port = await navigator.serial.requestPort();
      portRef.current = port as SerialPortLike;
      setPortInfo(describePort(portRef.current));

      setStatus(`Abriendo @ ${BAUD} ${modeStr()}…`);
      await openPort(portRef.current);

      const decoder = new TextDecoderStream("ascii", { fatal: false, ignoreBOM: true });
      const lined = portRef.current.readable!
        .pipeThrough(decoder as any)
        .pipeThrough(makeLineTransformer(DELIM));
      const reader = lined.getReader();
      readerRef.current = reader;

      keepRef.current = true;
      setStatus(`Conectado y leyendo… (${BAUD} ${modeStr()}, ${DELIM === "\r\n" ? "CRLF" : "CR"})`);

      (async () => {
        while (keepRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          if (typeof value !== "string") continue;

          const raw = value.trim();
          if (!raw) continue;
          setRawLine(raw);

          const res = parseLaTorre(raw);
          if (res.ok && typeof res?.kg === "number") {
            setWeight(res?.kg?.toFixed(3));
            setLog(p => [
              `[LATORRE] RAW='${raw}' -> ${res?.kg?.toFixed(3)} kg`,
              ...p
            ].slice(0, 200));
          } else {
            setLog(p => [`[IGN] '${raw}'`, ...p].slice(0, 200));
          }
        }
      })().catch(e => setLog(p => [`[read loop] ${String(e)}`, ...p].slice(0, 200)));

    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? e}`);
      setLog(p => [`[connect] ${String(e?.message ?? e)}`, ...p].slice(0, 200));
    }
  }

  async function disconnect() {
    keepRef.current = false;
    try { readerRef.current?.releaseLock(); } catch {}
    try { await portRef.current?.close?.(); } catch {}
    setStatus("Desconectado");
    setPortInfo("—");
    portRef.current = null;
  }

  // Diagnóstico: leer bytes crudos del puerto por 150ms
  async function peekBytes() {
    if (!portRef.current?.readable) return;
    const r = portRef.current.readable.getReader();
    const { value } = await Promise.race([
      r.read(),
      new Promise<{ value?: Uint8Array }>(res => setTimeout(() => res({}), 150))
    ]);
    r.releaseLock();
    if (value?.length) setLog(p => [`[RAW HEX] ${hex(value)}`, ...p].slice(0, 200));
    else setLog(p => [`[RAW HEX] (sin datos en 150 ms)`, ...p].slice(0, 200));
  }

  useEffect(() => {
    if (!supportsWebSerial) return;
    const onConnect = () => setLog(p => ["[evento] Nuevo dispositivo serie conectado", ...p].slice(0, 200));
    const onDisconnect = () => setLog(p => ["[evento] Dispositivo serie desconectado", ...p].slice(0, 200));
    navigator.serial.addEventListener("connect", onConnect as any);
    navigator.serial.addEventListener("disconnect", onDisconnect as any);
    return () => {
      navigator.serial.removeEventListener("connect", onConnect as any);
      navigator.serial.removeEventListener("disconnect", onDisconnect as any);
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 820, margin: "40px auto", fontFamily: "system-ui, Arial", color: "#eee", background: "#111", padding: 16, borderRadius: 10 }}>
      <h1>Lectura La Torre L1001 – Test - Option 1</h1>
      <p style={{ marginTop: 0, color: "#aaa" }}>
        Config puerto: <code>{BAUD} {modeStr()}</code> · fin de línea <code>{DELIM === "\r\n" ? "CRLF" : "CR"}</code> · Formato esperado <code>D######</code>
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button onClick={connect} disabled={!supportsWebSerial || !!portRef.current}>Conectar</button>
        <button onClick={disconnect} disabled={!portRef.current}>Desconectar</button>
        <button onClick={peekBytes} disabled={!portRef.current}>Ver bytes crudos</button>
        <span><strong>Estado:</strong> {status}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ padding: 12, border: "1px solid #333", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#999" }}>Puerto</div>
          <div><code>{portInfo}</code></div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>Último RAW</div>
          <div style={{ fontSize: 24 }}>{rawLine}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>Peso (kg)</div>
          <div style={{ fontSize: 40, fontWeight: 800 }}>{weight}</div>
        </div>

        <pre style={{ height: 280, overflow: "auto", background: "#0a0a0a", color: "#c3f3c3", padding: 12, borderRadius: 8, margin: 0 }}>
          {log.join("\n")}
        </pre>
      </div>
    </div>
  );
}
