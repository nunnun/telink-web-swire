import type { WebSerialTransport } from "./web-serial";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function encodeSwire(bytes: Uint8Array | number[]): Uint8Array {
  const packet: number[] = [];
  let start = 0x80;
  for (const byte of bytes) {
    packet.push(start);
    for (let mask = 0x80; mask; mask >>= 1) packet.push(byte & mask ? 0x80 : 0xfe);
    packet.push(0xfe);
    start = 0xfe;
  }
  return Uint8Array.from(packet);
}

export function decodeSwire(bytes: Uint8Array): number {
  if (bytes.length !== 9 || (bytes[8] & 0xfe) !== 0xfe) throw new Error("invalid SWire response frame");
  let data = 0;
  let bitMask = 0x20;
  for (let index = 0; index < 8; index += 1) {
    data <<= 1;
    if ((bytes[index] & bitMask) === 0) data |= 1;
    bitMask = 0x10;
  }
  return data;
}

export class SwireBus {
  private readonly transport: WebSerialTransport;

  constructor(transport: WebSerialTransport) {
    this.transport = transport;
  }

  private writeCommand(address: number, data: Uint8Array | number[]): Uint8Array {
    const body = encodeSwire(Uint8Array.from([0x5a, (address >> 8) & 0xff, address & 0xff, 0x00, ...data]));
    const end = encodeSwire([0xff]);
    const command = new Uint8Array(body.length + end.length);
    command.set(body);
    command.set(end, body.length);
    return command;
  }

  private readCommand(address: number): Uint8Array {
    return encodeSwire(Uint8Array.from([0x5a, (address >> 8) & 0xff, address & 0xff, 0x80]));
  }

  private endCommand(): Uint8Array {
    return encodeSwire([0xff]);
  }

  async writeRegister(address: number, data: Uint8Array | number[]): Promise<void> {
    await this.transport.writeEcho(this.writeCommand(address, data));
  }

  async readRegister(address: number, size = 1): Promise<Uint8Array> {
    await sleep(50);
    this.transport.clearInput();
    await this.transport.writeEcho(this.readCommand(address));
    const output = new Uint8Array(size);
    try {
      for (let index = 0; index < size; index += 1) {
        this.transport.clearInput();
        await this.transport.write(Uint8Array.of(0xfe));
        output[index] = decodeSwire(await this.transport.readExact(9));
      }
      return output;
    } finally {
      await this.transport.writeEcho(this.endCommand()).catch(() => undefined);
    }
  }

  async writeFifo(address: number, data: Uint8Array | number[]): Promise<void> {
    await this.writeRegister(0x00b3, [0x80]);
    try {
      await this.writeRegister(address, data);
    } finally {
      await this.writeRegister(0x00b3, [0x00]);
    }
  }

  async haltCpu(register: number, value: number, durationMs: number): Promise<void> {
    const frame = this.writeCommand(register, [value]);
    const deadline = performance.now() + durationMs;
    while (performance.now() < deadline) await this.transport.writeFramed(frame);
    await sleep(50);
    this.transport.clearInput();
  }

  async resetCpu(register: number, value: number): Promise<void> {
    await this.writeRegister(register, [value]);
  }

  async setSpeed(clockHz: number): Promise<number> {
    const divider = Math.round((clockHz * 2) / this.transport.baudRate);
    if (divider <= 0 || divider > 0x7f) throw new Error("UART baud rate is too low for this chip clock");
    await this.writeRegister(0x00b2, [divider]);
    const actual = await this.readRegister(0x00b2, 1);
    if (actual[0] !== divider) throw new Error(`SWire speed verification failed: wrote ${divider}, read ${actual[0]}`);
    return divider;
  }
}
