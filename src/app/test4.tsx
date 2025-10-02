/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import React, { useEffect, useRef, useState } from 'react';

/* ===== Tipos mínimos Web Serial ===== */
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
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
  }
  interface Navigator {
    serial: {
      requestPort(opts?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPort>;
      getPorts(): Promise<SerialPort[]>;
      addEventListener(type: 'connect' | 'disconnect', listener: any): void;
      removeEventListener(type: 'connect' | 'disconnect', listener: any): void;
    };
  }
}

type SerialPortLike = SerialPort & {
  setSignals?: (signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void>;
};

const supportsWebSerial =
  typeof navigator !== 'undefined' && 'serial' in (navigator as any);

/* ===== Config (Opción 2: 8N1 + CR) ===== */
const BAUD = 1200;
const DATABITS: 7 | 8 = 8;
const PARITY: 'none' | 'even' | 'odd' = 'none';
const STOPBITS: 1 | 2 = 1;
const DELIM = '\r';

/* ===== Afinado de UX =====
   - Si no recibimos tramas durante este tiempo, “reseteamos” el display a 0.000
   - Subí/bajá según cómo emita tu indicador La Torre.
*/
const FRAME_TIMEOUT_MS = 800;

/* Pequeño suavizado para evitar que titile si llegan variaciones mínimas */
const SMOOTH_WINDOW = 3; // promedio móvil simple de N lecturas

/* ===== Utils ===== */
function makeLineTransformer(delimiter = '\r') {
  let buffer = '';
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split(delimiter);
      buffer = parts.pop() ?? '';
      for (const p of parts) controller.enqueue(p);
    },
    flush(controller) {
      if (buffer) controller.enqueue(buffer);
    },
  });
}

/* ===== Parser La Torre =====
   Espera tramas “D######” (6 dígitos en gramos).  D025500 -> 25.500 kg
*/
function parseLaTorre(rawIn: string): { ok: boolean; kg?: number } {
  const raw = rawIn.trim();
  const m = raw.match(/^D(\d{6})$/i);
  if (!m) return { ok: false };
  const grams = Number(m[1]);
  if (!Number.isFinite(grams)) return { ok: false };
  return { ok: true, kg: grams / 1000 };
}

/* ===== Componente ===== */
export default function BalanzaLaTorre() {
  const [connected, setConnected] = useState(false);
  const [displayKg, setDisplayKg] = useState('0.000');

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const keepRef = useRef(false);

  const lastSeenRef = useRef<number>(0);
  const smoothRef = useRef<number[]>([]);

  // watchdog: si no llegan tramas, volver a 0.000
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      if (!lastSeenRef.current) return;
      const elapsed = Date.now() - lastSeenRef.current;
      if (elapsed > FRAME_TIMEOUT_MS) {
        smoothRef.current = [];
        setDisplayKg('0.000');
      }
    }, 120);
    return () => clearInterval(id);
  }, [connected]);

  async function openPort(port: SerialPortLike) {
    try { readerRef.current?.releaseLock(); } catch {}
    try { await port.close?.(); } catch {}
    await new Promise((r) => setTimeout(r, 50));

    await port.open({
      baudRate: BAUD,
      dataBits: DATABITS,
      parity: PARITY,
      stopBits: STOPBITS,
      flowControl: 'none',
    });
    if (port.setSignals)
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await new Promise((r) => setTimeout(r, 40));
  }

  async function connect() {
    try {
      if (!supportsWebSerial) throw new Error('Este navegador no soporta Web Serial');

      // Primera vez: popup; luego el navegador recuerda el permiso
      const port = (await navigator.serial.requestPort()) as SerialPortLike;
      portRef.current = port;
      await openPort(port);

      const decoder = new TextDecoderStream('ascii', { fatal: false, ignoreBOM: true });
      const lined = port.readable!.pipeThrough(decoder as any).pipeThrough(makeLineTransformer(DELIM));
      const reader = lined.getReader();
      readerRef.current = reader;

      keepRef.current = true;
      setConnected(true);
      lastSeenRef.current = 0;
      smoothRef.current = [];
      setDisplayKg('0.000');

      (async () => {
        while (keepRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          if (typeof value !== 'string') continue;

          const raw = value.trim();
          if (!raw) continue;

          const res = parseLaTorre(raw);
          if (!res.ok || typeof res.kg !== 'number') continue;

          // timestamp de “vida”
          lastSeenRef.current = Date.now();

          // suavizado simple
          const arr = smoothRef.current;
          arr.push(res.kg);
          if (arr.length > SMOOTH_WINDOW) arr.shift();
          const avg = arr.reduce((a, b) => a + b, 0) / arr.length;

          setDisplayKg(avg.toFixed(3));
        }
      })().catch(() => {
        // Si la lectura cae, dejamos el watchdog encargarse del 0.000
      });
    } catch (e) {
      console.error(e);
      setConnected(false);
      setDisplayKg('0.000');
    }
  }

  async function disconnect() {
    keepRef.current = false;
    try { readerRef.current?.releaseLock(); } catch {}
    try { await portRef.current?.close?.(); } catch {}
    setConnected(false);
    setDisplayKg('0.000');
  }

  // Limpieza on unmount
  useEffect(() => {
    return () => { disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        background: '#0b0b0c',
        color: '#eaeaea',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        fontFamily: 'system-ui, Arial, sans-serif',
      }}
    >
      {/* <h1 style={{ margin: 0, fontWeight: 700, letterSpacing: 1 }}>Balanza La Torre</h1> */}

      <div
        style={{
          fontSize: '14vw',            // muy grande y responsivo
          lineHeight: 1,
          fontWeight: 800,
          letterSpacing: '0.05em',
          padding: '0.15em 0.25em',
          borderRadius: 16,
          background: '#111',
          boxShadow: '0 0 40px rgba(0,0,0,.35) inset, 0 0 30px rgba(0,0,0,.4)',
        //   minWidth: '70vw',
          textAlign: 'center',
        }}
      >
        {displayKg}
      </div>

      {!connected ? (
        <button
          onClick={connect}
          style={{
            padding: '14px 22px',
            borderRadius: 12,
            border: '1px solid #2a2a2a',
            background: '#1c1c1f',
            color: '#fff',
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          Conectar balanza
        </button>
      ) : (
        <button
          onClick={disconnect}
          style={{
            padding: '10px 18px',
            borderRadius: 10,
            border: '1px solid #292929',
            background: '#19191b',
            color: '#bbb',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Desconectar
        </button>
      )}
    </div>
  );
}
