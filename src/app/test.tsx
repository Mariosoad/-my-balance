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

async function writeToken(port: SerialPort, text: string) {
    const writer = port.writable!.getWriter();
    const data = new TextEncoder().encode(text);
    await writer.write(data);
    writer.releaseLock();
  }
  
  async function readSomeBytes(port: SerialPort, millis = 150): Promise<Uint8Array> {
    const reader = port.readable!.getReader();
    const chunks: number[] = [];
    const deadline = Date.now() + millis;
  
    try {
      while (Date.now() < deadline) {
        const timeLeft = deadline - Date.now();
        const oneRead = reader.read(); // promesa de lectura
        const timeout = new Promise<{ value?: Uint8Array; done?: boolean }>(res =>
          setTimeout(() => res({ value: undefined, done: false }), Math.max(1, timeLeft))
        );
  
        const { value, done } = await Promise.race([oneRead, timeout]);
        if (done) break;
        if (value && value.length) chunks.push(...Array.from(value));
        // pequeño respiro para evitar loop caliente
        await new Promise(r => setTimeout(r, 5));
      }
    } finally {
      reader.releaseLock();
    }
    return new Uint8Array(chunks);
  }
  
  

const supportsWebSerial = typeof navigator !== "undefined" && "serial" in navigator as any;

// —— Parámetros de auto-detección ——
const BAUDS = [1200] as const;
const SETUPS = [
    { dataBits: 7 as const, parity: "none" as const, stopBits: 1 as const, name: "7N1" },
    { dataBits: 8 as const, parity: "none" as const, stopBits: 1 as const, name: "8N1" }, // por si acaso
  ];
  const DELIMS = ["\r"] as const; // fin de línea CR
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

  async function openWithConfig(port: SerialPortLike, baudRate: number, dataBits: 7|8, parity: "none"|"even", stopBits: 1) {
    try { readerRef.current?.releaseLock(); } catch {}
    try { await port.close?.(); } catch {}
    await new Promise(r => setTimeout(r, 60));
  
    try {
      await port.open({ baudRate, dataBits, parity, stopBits, flowControl: "none" });
      if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setLog(p => [`[openWithConfig error] ${msg}`, ...p].slice(0,80));
      setStatus(`Error abriendo puerto: ${msg}`);
      throw e; // re-lanza para que la autodetección pruebe otra combinación
    }
    await new Promise(r => setTimeout(r, 40));
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
    } catch (e: any) {
        setLog(p => [`[probeOnce] fallo en ${cfg.name}: ${String(e?.message ?? e)}`, ...p].slice(0,80));
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

  async function loopbackTest(port: SerialPortLike): Promise<boolean> {
    // Abre con una config tolerante; para loopback cualquier baud sirve si TX=RX.
    await openWithConfig(port, 9600, 8, "none", 1);
    // Sube señales por si el puerto las requiere
    if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  
    // Token único + CR para facilitar ver líneas si tu vista usa delimitadores
    const token = `LBK${Math.floor(Math.random()*1e6)}\r`;
    await writeToken(port, token);
  
    // Espera breve y lee bytes crudos
    const bytes = await readSomeBytes(port, 250);
    if (bytes.length === 0) return false;
  
    // ¿Volvió el token? Compara por bytes (más robusto que texto)
    const enc = new TextEncoder().encode(token);
    const hayEco = bytes.join(",").includes(enc.join(","));
    // Log opcional en RAW/HEX
    setLog(p => [
      `Loopback RX HEX: ${Array.from(bytes).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`,
      ...p
    ].slice(0,80));
    return hayEco;
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
    
          // 1) Intento normal: autodetección (balanza real enviando)
          const cfg = await autoDetect(port);
          if (cfg) {
            currentConfigRef.current = cfg;
            await startReading(port, cfg);
            return;
          }
    
          // 2) Plan B: loopback (si estás puenteando 2–3)
          setStatus("Sin datos de balanza. Probando loopback…");
          const ok = await loopbackTest(port);
          if (ok) {
            setStatus("Loopback detectado (eco OK). El puerto funciona.");
            setActive(true);
            setConfigLabel("Loopback @9600");
            setRawLine("ECO OK");
            setWeight("-");
            return;
          } else {
            setLog(p => ["Loopback: no se recibió eco.", ...p].slice(0,80));
          }
        } catch {/* prueba siguiente */}
      }
      setStatus("No se detectó balanza ni loopback en puertos permitidos");
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
