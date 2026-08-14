import type { DeviceProfile } from "./profile";
import { formatHex, validateWritePlan } from "./profile";
import { SwireBus } from "./swire";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Progress = (message: string, completed?: number, total?: number) => void;

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function allErased(data: Uint8Array): boolean {
  return data.every((byte) => byte === 0xff);
}

export class Tlsr826xFlash {
  constructor(private readonly bus: SwireBus, private readonly profile: DeviceProfile) {}

  private async spiTransaction(command: Uint8Array, readSize = 0): Promise<Uint8Array> {
    await this.bus.writeRegister(0x00b3, [0x80]);
    try {
      await this.bus.writeRegister(0x000d, [0x00]);
      await this.bus.writeRegister(0x000c, command);
      if (!readSize) {
        await this.bus.writeRegister(0x000d, [0x01]);
        return new Uint8Array();
      }
      await this.bus.writeRegister(0x000d, [0x0a]);
      return await this.bus.readRegister(0x000c, readSize);
    } finally {
      await this.bus.writeRegister(0x000d, [0x01]).catch(() => undefined);
      await this.bus.writeRegister(0x00b3, [0x00]).catch(() => undefined);
    }
  }

  async readJedec(): Promise<Uint8Array> {
    return this.spiTransaction(Uint8Array.of(0x9f, 0x00), 3);
  }

  async readOnce(address: number, size: number): Promise<Uint8Array> {
    if (address < 0 || size <= 0 || address + size > this.profile.flash.size) throw new Error("read range is outside flash");
    return this.spiTransaction(
      Uint8Array.of(0x03, (address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff, 0x00),
      size,
    );
  }

  async verifiedRead(address: number, size: number, progress: Progress): Promise<Uint8Array> {
    if (address < 0 || size <= 0 || address + size > this.profile.flash.size) throw new Error("read range is outside flash");
    const output = new Uint8Array(size);
    const blockSize = this.profile.read.blockSize;
    for (let relative = 0; relative < size; relative += blockSize) {
      const length = Math.min(blockSize, size - relative);
      let accepted: Uint8Array | null = null;
      for (let attempt = 1; attempt <= this.profile.read.retries; attempt += 1) {
        const first = await this.readOnce(address + relative, length);
        const second = this.profile.read.comparePasses === 2 ? await this.readOnce(address + relative, length) : first;
        if (equal(first, second)) {
          accepted = first;
          break;
        }
        progress(`Read mismatch at ${formatHex(address + relative)}; retry ${attempt}`);
      }
      if (!accepted) throw new Error(`no verified read at ${formatHex(address + relative)}`);
      output.set(accepted, relative);
      progress(`Read ${formatHex(address + relative)} · ${relative + length}/${size} bytes`, relative + length, size);
    }
    return output;
  }

  private async readStatus(): Promise<number> {
    return (await this.spiTransaction(Uint8Array.of(0x05), 1))[0];
  }

  private async waitReady(attempts = 50): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
      if (((await this.readStatus()) & 0x01) === 0) return;
      await sleep(10);
    }
    throw new Error("flash remained busy after timeout");
  }

  private async writeEnable(): Promise<void> {
    await this.spiTransaction(Uint8Array.of(0x06));
  }

  async unlock(): Promise<void> {
    await this.writeEnable();
    await this.bus.writeRegister(0x000d, [0x00]);
    await this.bus.writeRegister(0x000c, [0x01]);
    await this.bus.writeRegister(0x000c, [0x00]);
    await this.bus.writeRegister(0x000d, [0x01]);
    await this.waitReady();
  }

  async eraseSector(address: number): Promise<void> {
    if (address % this.profile.flash.sectorSize) throw new Error("sector erase address is not aligned");
    await this.writeEnable();
    await this.bus.writeRegister(0x000d, [0x00]);
    await this.bus.writeRegister(0x000c, [0x20]);
    await this.bus.writeRegister(0x000c, [(address >> 16) & 0xff]);
    await this.bus.writeRegister(0x000c, [(address >> 8) & 0xff]);
    await this.bus.writeRegister(0x000c, [address & 0xff]);
    await this.bus.writeRegister(0x000d, [0x01]);
    await sleep(80);
    await this.waitReady();
  }

  async pageProgram(address: number, data: Uint8Array): Promise<void> {
    if (!data.length || data.length > this.profile.flash.pageSize) throw new Error("invalid page program size");
    if (Math.floor(address / this.profile.flash.pageSize) !== Math.floor((address + data.length - 1) / this.profile.flash.pageSize)) {
      throw new Error("page program crosses a page boundary");
    }
    if (allErased(data)) return;
    await this.writeEnable();
    await this.bus.writeRegister(0x000d, [0x00]);
    try {
      await this.bus.writeFifo(0x000c, Uint8Array.of(0x02, (address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff, ...data));
    } finally {
      await this.bus.writeRegister(0x000d, [0x01]);
    }
    await this.waitReady();
  }

  async writeVerified(offset: number, image: Uint8Array, progress: Progress): Promise<{ backup: Uint8Array; eraseStart: number; eraseEnd: number }> {
    const { eraseStart, eraseEnd } = validateWritePlan(this.profile, offset, image);
    const total = eraseEnd - eraseStart;
    progress(`Backing up affected sectors ${formatHex(eraseStart)}–${formatHex(eraseEnd)}`);
    const backup = await this.verifiedRead(eraseStart, total, progress);
    const desired = backup.slice();
    desired.set(image, offset - eraseStart);

    await this.unlock();
    for (let address = eraseStart; address < eraseEnd; address += this.profile.flash.sectorSize) {
      progress(`Erasing sector ${formatHex(address)}`, address - eraseStart, total);
      await this.eraseSector(address);
      const sectorOffset = address - eraseStart;
      for (let page = 0; page < this.profile.flash.sectorSize; page += this.profile.flash.pageSize) {
        const expected = desired.slice(sectorOffset + page, sectorOffset + page + this.profile.flash.pageSize);
        await this.pageProgram(address + page, expected);
      }
      for (let page = 0; page < this.profile.flash.sectorSize; page += this.profile.flash.pageSize) {
        const expected = desired.slice(sectorOffset + page, sectorOffset + page + this.profile.flash.pageSize);
        let verified = false;
        for (let attempt = 1; attempt <= this.profile.write.verifyAttempts; attempt += 1) {
          if (equal(await this.readOnce(address + page, expected.length), expected)) {
            verified = true;
            break;
          }
          progress(`Verify retry ${attempt} at ${formatHex(address + page)}`);
        }
        if (!verified) throw new Error(`persistent verify failure at ${formatHex(address + page)}`);
      }
      progress(`Verified sector ${formatHex(address)}`, Math.min(total, address + this.profile.flash.sectorSize - eraseStart), total);
    }
    return { backup, eraseStart, eraseEnd };
  }

  async activate(imageBase: number, progress: Progress): Promise<void> {
    const patch = this.profile.write.activationPatch;
    if (!patch) throw new Error("profile has no activation patch");
    const address = imageBase + patch.offset;
    const current = await this.readOnce(address, patch.from.length);
    if (!equal(current, patch.from)) throw new Error(`activation precondition failed: ${patch.label}`);
    progress(`Applying activation patch: ${patch.label}`);
    await this.pageProgram(address, patch.to);
    const actual = await this.readOnce(address, patch.to.length);
    if (!equal(actual, patch.to)) throw new Error("activation patch verification failed");
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
