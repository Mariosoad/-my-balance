/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import React, { useEffect, useRef, useState } from "react";

// --- Tipos mínimos Web Serial ---
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

// --- Config por defecto (balanza / simulador) ---
const BAUD = 1200;
const DATABITS: 7 | 8 = 7;          // 7N1
const PARITY: "none" | "even" = "none";
const STOPBITS: 1 = 1 as const;
const DELIM = "\r";

// --- Utilidades ---
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

export default function VirtualScaleTester() {
  const [status, setStatus] = useState<string>(supportsWebSerial ? "Listo para conectar" : "Web Serial no soportado");
  const [weight, setWeight] = useState<string>("-");
  const [rawLine, setRawLine] = useState<string>("-");
  const [log, setLog] = useState<string[]>([]);
  const [portInfo, setPortInfo] = useState<string>("—");

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const keepRef = useRef<boolean>(false);

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
    if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await new Promise(r => setTimeout(r, 40));
  }

  async function connect() {
    try {
      if (!supportsWebSerial) throw new Error("Navegador sin Web Serial");
      setStatus("Selecciona el puerto virtual (el opuesto al feeder)...");
      const port = await navigator.serial.requestPort(); // muestra COMs virtuales
      portRef.current = port as SerialPortLike;

      setPortInfo(describePort(portRef.current));
      setStatus(`Abriendo puerto @ ${BAUD} ${DATABITS}${PARITY === "none" ? "N" : "E"}${STOPBITS}…`);
      await openPort(portRef.current);

      const decoder = new TextDecoderStream("ascii", { fatal: false, ignoreBOM: true });
      const lined = portRef.current.readable!.pipeThrough(decoder as any).pipeThrough(makeLineTransformer(DELIM));
      const reader = lined.getReader();
      readerRef.current = reader;

      keepRef.current = true;
      setStatus("Conectado y leyendo…");

      (async () => {
        while (keepRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          if (typeof value !== "string") continue;

          const raw = value.trim();
          if (!raw) continue;

          setRawLine(raw);
          const w = parseWeight(raw);
          if (w) setWeight(w);
        }
      })().catch(e => setLog(p => [`[read loop] ${String(e)}`, ...p].slice(0, 120)));

    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? e}`);
      setLog(p => [`[connect] ${String(e?.message ?? e)}`, ...p].slice(0, 120));
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

  function describePort(p: SerialPort) {
    try {
      const info = (p.getInfo?.() ?? {}) as any;
      const vid = info.usbVendorId ? "VID " + toHex(info.usbVendorId) : "";
      const pid = info.usbProductId ? "PID " + toHex(info.usbProductId) : "";
      return [vid, pid].filter(Boolean).join(" ");
    } catch { return "—"; }
  }
  function toHex(n: number) { return "0x" + (n >>> 0).toString(16).toUpperCase().padStart(4, "0"); }

  // ver bytes crudos (para diagnóstico rápido)
  async function peekBytes() {
    if (!portRef.current?.readable) return;
    const reader = portRef.current.readable.getReader();
    const { value } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array }>(res => setTimeout(() => res({}), 150))
    ]);
    reader.releaseLock();
    if (value?.length) setLog(p => [`[RAW HEX] ${hex(value)}`, ...p].slice(0, 120));
    else setLog(p => [`[RAW HEX] (sin datos en 150 ms)`, ...p].slice(0, 120));
  }

  useEffect(() => {
    if (!supportsWebSerial) return;
    const onConnect = () => setLog(p => ["[evento] Nuevo dispositivo serie conectado", ...p].slice(0, 120));
    const onDisconnect = () => setLog(p => ["[evento] Dispositivo serie desconectado", ...p].slice(0, 120));
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
    <div style={{ maxWidth: 780, margin: "40px auto", fontFamily: "system-ui, Arial" }}>
      <h1>Tester de Balanza – Puerto Serie Virtual</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Config: <code>{BAUD} {DATABITS}{PARITY === "none" ? "N" : "E"}{STOPBITS}</code>, fin de línea <code>CR</code>
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button onClick={connect} disabled={!supportsWebSerial || !!portRef.current}>Conectar</button>
        <button onClick={disconnect} disabled={!portRef.current}>Desconectar</button>
        <button onClick={peekBytes} disabled={!portRef.current}>Ver bytes crudos</button>
        <span><strong>Estado:</strong> {status}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Puerto</div>
          <div><code>{portInfo}</code></div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>Último RAW</div>
          <div style={{ fontSize: 24 }}>{rawLine}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>Peso</div>
          <div style={{ fontSize: 40, fontWeight: 700 }}>{weight}</div>
        </div>

        <pre style={{ height: 240, overflow: "auto", background: "#0a0a0a", color: "#c3f3c3", padding: 12, borderRadius: 8, margin: 0 }}>
          {log.join("\n")}
        </pre>
      </div>
    </div>
  );
}
