/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import React, { useRef, useState } from "react";

/**
 * Web Serial auto-detect for industrial scale
 * - Tries common combinations until it finds readable weight lines.
 * - Shows Active/Inactive and last weight parsed.
 * Requirements: HTTPS (or localhost) + Chrome/Edge desktop.
 */

// Web Serial API type declarations
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
    };
  }
}

type SerialPortLike = SerialPort & {
  setSignals?: (signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void>;
};

const supportsWebSerial = "serial" in navigator;

// Combinaciones de prueba (ordenadas de más probables a menos)
const BAUDS = [1200, 2400, 4800, 9600, 19200] as const;
const SETUPS = [
  { dataBits: 8 as const, parity: "none" as const, stopBits: 1 as const, name: "8N1" },
  { dataBits: 7 as const, parity: "even" as const, stopBits: 1 as const, name: "7E1" },
];
const DELIMS = ["\r", "\r\n", "\n"] as const;

// Tiempo de escucha por intento (ms)
const PROBE_MS = 2000;

// Expresión para detectar un número de peso (ej. "+12.34", " 0012,3")
const weightRegex = /([+\-]?\d{1,6}(?:[.,]\d{1,3})?)/;

/** Intenta parsear un número de una línea RAW; devuelve null si no hay match. */
function parseWeight(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  const m = s.match(weightRegex);
  return m ? m[1].replace(",", ".") : null;
}

/** Transforma bytes a líneas usando un delimitador. */
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
    },
  });
}

type DetectedConfig = {
  baudRate: number;
  dataBits: 7 | 8;
  parity: "none" | "even";
  stopBits: 1;
  delimiter: "\r" | "\r\n" | "\n";
  name: string; // ej. "1200 8N1 CR"
};

export default function ScaleAutoDetect() {
  const [status, setStatus] = useState<string>(supportsWebSerial ? "Listo para conectar" : "Web Serial no soportado");
  const [active, setActive] = useState<boolean>(false);
  const [weight, setWeight] = useState<string>("-");
  const [rawLine, setRawLine] = useState<string>("-");
  const [configLabel, setConfigLabel] = useState<string>("-");
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
    // Cerrar si estaba abierto
    try {
      if ((port as any).readable) readerRef.current?.releaseLock();
      if (port.close) await port.close();
    } catch {}
    // Abrir con la config
    await port.open({ baudRate, dataBits, parity, stopBits, flowControl: "none" as const });
    // Elevar señales por si el equipo las necesita
    if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  }

  /** Prueba una combinación (framing/baud/terminador) durante PROBE_MS; retorna peso si hay match. */
  async function probeOnce(port: SerialPortLike, cfg: DetectedConfig): Promise<{ ok: boolean; sample?: string; raw?: string }> {
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

  /** Intenta todas las combinaciones conocidas hasta encontrar una válida. */
  async function autoDetect(port: SerialPortLike): Promise<DetectedConfig | null> {
    for (const b of BAUDS) {
      for (const s of SETUPS) {
        for (const d of DELIMS) {
          const cfg: DetectedConfig = {
            baudRate: b,
            dataBits: s.dataBits,
            parity: s.parity,
            stopBits: 1,
            delimiter: d,
            name: `${b} ${s.name} ${d === "\r" ? "CR" : d === "\r\n" ? "CRLF" : "LF"}`,
          };
          setStatus(`Probando ${cfg.name}…`);
          const r = await probeOnce(port, cfg);
          if (r.ok) {
            setLog((prev) => [`✔ Detectado con ${cfg.name} | Ej: RAW='${r.raw}' Peso=${r.sample}`, ...prev].slice(0, 100));
            setRawLine(r.raw!);
            setWeight(r.sample!);
            return cfg;
          }
        }
      }
    }
    return null;
  }

  /** Conectar y auto-detectar */
  async function connect() {
    try {
      if (!supportsWebSerial) throw new Error("Este navegador no soporta Web Serial.");
      setStatus("Solicitando puerto…");
      const port = (await (navigator as any).serial.requestPort()) as SerialPortLike;
      portRef.current = port;

      setStatus("Auto-detectando…");
      const cfg = await autoDetect(port);
      if (!cfg) {
        setActive(false);
        setStatus("No se pudo detectar configuración");
        setConfigLabel("-");
        return;
      }
      currentConfigRef.current = cfg;
      setConfigLabel(cfg.name);

      // Re-abrimos con la configuración final y nos quedamos leyendo
      await openWithConfig(port, cfg.baudRate, cfg.dataBits, cfg.parity, cfg.stopBits);

      const decoder = new TextDecoderStream("ascii", { fatal: false, ignoreBOM: true });
      const lined = port.readable!.pipeThrough(decoder as any).pipeThrough(makeLineTransformer(cfg.delimiter));
      const reader = lined.getReader();
      readerRef.current = reader;

      setActive(true);
      setStatus("Activo (leyendo)");

      keepReadingRef.current = true;
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
          setLog((prev) => [`RAW='${raw}' → ${parsed ?? "?"}`, ...prev].slice(0, 100));
        }
      })().catch((e) => setLog((p) => [`Error lectura: ${String(e)}`, ...p]));
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? e}`);
      setActive(false);
    }
  }

  async function disconnect() {
    keepReadingRef.current = false;
    try {
      readerRef.current?.releaseLock();
    } catch {}
    try {
      await portRef.current?.close?.();
    } catch {}
    portRef.current = null;
    setActive(false);
    setStatus("Desconectado");
  }

  return (
    <div style={{ maxWidth: 760, margin: "40px auto", fontFamily: "system-ui, Arial" }}>
      <h1>Lectura Balanza</h1>
      {/* <p style={{ marginTop: 0, color: "#666" }}>
        Requiere Chrome/Edge en <strong>HTTPS</strong> (o localhost). Elige el puerto al conectar.
      </p> */}
      <br />

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <button onClick={connect} disabled={!supportsWebSerial || !!portRef.current}>
          Conectar
        </button>
        <button onClick={disconnect} disabled={!portRef.current}>
          Desconectar
        </button>
        <span>
          <strong>Estado:</strong> {status}
        </span>
        <span>
          <strong>Config:</strong> {configLabel}
        </span>
        <span>
          <strong>Puerto:</strong> {portRef.current ? "Conectado" : "—"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Estado balanza</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: active ? "#0a7" : "#c33" }}>
            {active ? "ACTIVO" : "INACTIVO"}
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Auto-detect: baudios · framing · terminador</div>
        </div>
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Peso</div>
          <div style={{ fontSize: 40, fontWeight: 800 }}>{weight}</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Último RAW: <code>{rawLine}</code></div>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Log</h3>
      <pre style={{ height: 220, overflow: "auto", background: "#0a0a0a", color: "#c3f3c3", padding: 12, borderRadius: 8 }}>
        {log.join("\n")}
      </pre>

      {!supportsWebSerial && (
        <div style={{ marginTop: 12, padding: 12, background: "#fff4e5", border: "1px solid #ffd399", borderRadius: 8 }}>
          Tu navegador no soporta Web Serial. Usá Chrome/Edge desktop.
        </div>
      )}
    </div>
  );
}
