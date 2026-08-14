export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: "none" | "even" | "odd";
    bufferSize?: number;
    flowControl?: "none" | "hardware";
  }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
}

interface SerialApi {
  requestPort(options?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPortLike>;
}

export function getSerialApi(): SerialApi | undefined {
  return (navigator as Navigator & { serial?: SerialApi }).serial;
}

export class WebSerialTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private chunks: number[] = [];
  private waiters = new Set<() => void>();
  private readLoop: Promise<void> | null = null;
  private readFailure: Error | null = null;
  private closed = false;

  constructor(
    private readonly port: SerialPortLike,
    readonly baudRate: number,
    readonly timeoutMs: number,
    readonly highSpeedChunkBytes: number,
  ) {}

  async open(): Promise<void> {
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 65536,
    });
    await this.port.setSignals?.({ dataTerminalReady: false, requestToSend: false });
    if (!this.port.readable || !this.port.writable) throw new Error("serial streams are unavailable");
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoop = this.pumpReads();
  }

  private async pumpReads(): Promise<void> {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.chunks.push(...value);
        if (this.chunks.length > 2_000_000) this.chunks.splice(0, this.chunks.length - 2_000_000);
        for (const wake of this.waiters) wake();
      }
    } catch (error) {
      if (!this.closed) this.readFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      for (const wake of this.waiters) wake();
    }
  }

  clearInput(): void {
    this.chunks.length = 0;
  }

  private waitForBytes(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      const timer = setTimeout(wake, timeoutMs);
    });
  }

  async readExact(length: number, timeoutMs = this.timeoutMs): Promise<Uint8Array> {
    const deadline = performance.now() + timeoutMs;
    while (this.chunks.length < length) {
      if (this.readFailure) throw this.readFailure;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`serial timeout: wanted ${length} bytes, received ${this.chunks.length}`);
      await this.waitForBytes(Math.min(remaining, 25));
    }
    return Uint8Array.from(this.chunks.splice(0, length));
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("serial port is not open");
    await this.writer.write(data);
  }

  async writeFramed(data: Uint8Array): Promise<void> {
    const chunkSize = this.baudRate > 460800 ? this.highSpeedChunkBytes : data.length;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      await this.write(data.slice(offset, offset + chunkSize));
    }
  }

  async writeEcho(data: Uint8Array): Promise<void> {
    this.clearInput();
    await this.writeFramed(data);
    // The target can pull down the joined TX/RX line, so—as in the upstream
    // pyserial implementation—the returned bytes are a length/continuity
    // check rather than an exact byte echo. Register read-back verifies data.
    await this.readExact(data.length);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      // The OS may already have closed a disconnected serial device.
    }
    try {
      this.reader?.releaseLock();
    } catch {
      // Ignore a lock released by a concurrent disconnect.
    }
    try {
      await this.writer?.close();
    } catch {
      // The writable stream can already be aborted after unplug.
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // Ignore a lock released by a concurrent disconnect.
    }
    this.reader = null;
    this.writer = null;
    await this.readLoop?.catch(() => undefined);
    await this.port.close();
  }
}
