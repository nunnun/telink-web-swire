export const PROFILE_SCHEMA = "telink-web-swire-device-profile-v1" as const;

export type AddressValue = number | string;

export interface AddressRangeInput {
  start: AddressValue;
  end: AddressValue;
  label?: string;
}

export interface FirmwareCheckInput {
  offset: AddressValue;
  hex: string;
  label: string;
}

export interface ActivationPatchInput {
  offset: AddressValue;
  fromHex: string;
  toHex: string;
  label: string;
}

export interface DeviceProfileInput {
  $schema?: string;
  schema: typeof PROFILE_SCHEMA;
  id: string;
  name: string;
  description?: string;
  chip: {
    family: "tlsr826x";
    clockHz: number;
  };
  transport: {
    baudRate: number;
    readTimeoutMs: number;
    highSpeedChunkBytes: number;
  };
  flash: {
    size: AddressValue;
    sectorSize: AddressValue;
    pageSize: AddressValue;
    jedecIds?: string[];
  };
  cpu: {
    stopRegister: AddressValue;
    stopValue: AddressValue;
    stopDurationMs: number;
    resetRegister: AddressValue;
    resetValue: AddressValue;
  };
  read: {
    blockSize: AddressValue;
    comparePasses: 1 | 2;
    retries: number;
  };
  write: {
    enabled: boolean;
    defaultOffset: AddressValue;
    allowedRanges: AddressRangeInput[];
    protectedRanges: AddressRangeInput[];
    verifyAttempts: number;
    firmwareChecks?: FirmwareCheckInput[];
    activationPatch?: ActivationPatchInput;
  };
}

export interface AddressRange {
  start: number;
  end: number;
  label: string;
}

export interface DeviceProfile {
  schema: typeof PROFILE_SCHEMA;
  id: string;
  name: string;
  description: string;
  chip: DeviceProfileInput["chip"];
  transport: DeviceProfileInput["transport"];
  flash: {
    size: number;
    sectorSize: number;
    pageSize: number;
    jedecIds: string[];
  };
  cpu: {
    stopRegister: number;
    stopValue: number;
    stopDurationMs: number;
    resetRegister: number;
    resetValue: number;
  };
  read: {
    blockSize: number;
    comparePasses: 1 | 2;
    retries: number;
  };
  write: {
    enabled: boolean;
    defaultOffset: number;
    allowedRanges: AddressRange[];
    protectedRanges: AddressRange[];
    verifyAttempts: number;
    firmwareChecks: Array<{ offset: number; bytes: Uint8Array; label: string }>;
    activationPatch?: {
      offset: number;
      from: Uint8Array;
      to: Uint8Array;
      label: string;
    };
  };
}

export function parseAddress(value: AddressValue, label = "address"): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (/^0x[0-9a-f]+$/i.test(value.trim())) {
    parsed = Number.parseInt(value.trim().slice(2), 16);
  } else if (/^[0-9]+$/.test(value.trim())) {
    parsed = Number.parseInt(value.trim(), 10);
  } else {
    throw new Error(`${label} must be a decimal number or 0x-prefixed hex string`);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffff) {
    throw new Error(`${label} is outside the 24-bit flash address range`);
  }
  return parsed;
}

export function parseHexBytes(value: string, label = "hex bytes"): Uint8Array {
  const compact = value.replace(/[\s:_-]/g, "").toLowerCase();
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/.test(compact)) {
    throw new Error(`${label} must contain an even number of hexadecimal digits`);
  }
  return Uint8Array.from(compact.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function normalizeRange(input: AddressRangeInput, label: string, flashSize: number): AddressRange {
  const start = parseAddress(input.start, `${label}.start`);
  const end = parseAddress(input.end, `${label}.end`);
  if (start >= end) throw new Error(`${label} must have start < end`);
  if (end > flashSize) throw new Error(`${label} exceeds flash size`);
  return { start, end, label: input.label || label };
}

export function parseProfile(value: unknown): DeviceProfile {
  requireObject(value, "profile");
  const input = value as unknown as DeviceProfileInput;
  if (input.schema !== PROFILE_SCHEMA) {
    throw new Error(`profile.schema must be ${PROFILE_SCHEMA}`);
  }
  if (!input.id || !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) {
    throw new Error("profile.id must use lowercase letters, numbers, dot, underscore, or hyphen");
  }
  if (!input.name || typeof input.name !== "string") throw new Error("profile.name is required");
  requireObject(input.chip, "profile.chip");
  requireObject(input.transport, "profile.transport");
  requireObject(input.flash, "profile.flash");
  requireObject(input.cpu, "profile.cpu");
  requireObject(input.read, "profile.read");
  requireObject(input.write, "profile.write");
  if (input.chip.family !== "tlsr826x") throw new Error("only tlsr826x is supported in v1");

  const clockHz = requirePositiveInteger(input.chip.clockHz, "chip.clockHz");
  const baudRate = requirePositiveInteger(input.transport.baudRate, "transport.baudRate");
  const readTimeoutMs = requirePositiveInteger(input.transport.readTimeoutMs, "transport.readTimeoutMs");
  const highSpeedChunkBytes = requirePositiveInteger(input.transport.highSpeedChunkBytes, "transport.highSpeedChunkBytes");
  if (highSpeedChunkBytes % 10 !== 0) throw new Error("transport.highSpeedChunkBytes must be a multiple of 10");

  const flashSize = parseAddress(input.flash.size, "flash.size");
  const sectorSize = parseAddress(input.flash.sectorSize, "flash.sectorSize");
  const pageSize = parseAddress(input.flash.pageSize, "flash.pageSize");
  if (!flashSize || !sectorSize || !pageSize) throw new Error("flash sizes must be positive");
  if (flashSize % sectorSize || sectorSize % pageSize) {
    throw new Error("flash.size must align to sectorSize and sectorSize to pageSize");
  }
  if (pageSize > 0x100) throw new Error("TLSR826x pageSize cannot exceed 256 bytes");

  const allowedRanges = input.write.allowedRanges.map((range, index) =>
    normalizeRange(range, `write.allowedRanges[${index}]`, flashSize),
  );
  if (typeof input.write.enabled !== "boolean") throw new Error("write.enabled must be true or false");
  if (input.write.enabled && !allowedRanges.length) throw new Error("write-enabled profiles require at least one allowed range");
  const protectedRanges = input.write.protectedRanges.map((range, index) =>
    normalizeRange(range, `write.protectedRanges[${index}]`, flashSize),
  );
  const defaultOffset = parseAddress(input.write.defaultOffset, "write.defaultOffset");
  const firmwareChecks = (input.write.firmwareChecks || []).map((check, index) => ({
    offset: parseAddress(check.offset, `write.firmwareChecks[${index}].offset`),
    bytes: parseHexBytes(check.hex, `write.firmwareChecks[${index}].hex`),
    label: check.label || `firmware check ${index + 1}`,
  }));

  let activationPatch: DeviceProfile["write"]["activationPatch"];
  if (input.write.activationPatch) {
    if (!input.write.enabled) throw new Error("read-only profiles cannot define an activation patch");
    const from = parseHexBytes(input.write.activationPatch.fromHex, "write.activationPatch.fromHex");
    const to = parseHexBytes(input.write.activationPatch.toHex, "write.activationPatch.toHex");
    if (from.length !== to.length) throw new Error("activation patch fromHex/toHex sizes differ");
    for (let index = 0; index < from.length; index += 1) {
      if ((from[index] & to[index]) !== to[index]) {
        throw new Error("activation patch may only change flash bits from 1 to 0");
      }
    }
    activationPatch = {
      offset: parseAddress(input.write.activationPatch.offset, "write.activationPatch.offset"),
      from,
      to,
      label: input.write.activationPatch.label,
    };
  }

  if (input.read.comparePasses !== 1 && input.read.comparePasses !== 2) {
    throw new Error("read.comparePasses must be 1 or 2");
  }
  const blockSize = parseAddress(input.read.blockSize, "read.blockSize");
  if (!blockSize || blockSize > pageSize) throw new Error("read.blockSize must be between 1 and flash.pageSize");
  const stopValue = parseAddress(input.cpu.stopValue, "cpu.stopValue");
  const resetValue = parseAddress(input.cpu.resetValue, "cpu.resetValue");
  if (stopValue > 0xff || resetValue > 0xff) throw new Error("CPU register values must fit in one byte");

  const jedecIds = (input.flash.jedecIds || []).map((id, index) => {
    const compact = id.replace(/[\s:_-]/g, "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(compact)) throw new Error(`flash.jedecIds[${index}] must contain exactly 3 bytes`);
    return compact;
  });

  return {
    schema: PROFILE_SCHEMA,
    id: input.id,
    name: input.name,
    description: input.description || "",
    chip: { family: "tlsr826x", clockHz },
    transport: { baudRate, readTimeoutMs, highSpeedChunkBytes },
    flash: {
      size: flashSize,
      sectorSize,
      pageSize,
      jedecIds,
    },
    cpu: {
      stopRegister: parseAddress(input.cpu.stopRegister, "cpu.stopRegister"),
      stopValue,
      stopDurationMs: requirePositiveInteger(input.cpu.stopDurationMs, "cpu.stopDurationMs"),
      resetRegister: parseAddress(input.cpu.resetRegister, "cpu.resetRegister"),
      resetValue,
    },
    read: {
      blockSize,
      comparePasses: input.read.comparePasses,
      retries: requirePositiveInteger(input.read.retries, "read.retries"),
    },
    write: {
      enabled: input.write.enabled,
      defaultOffset,
      allowedRanges,
      protectedRanges,
      verifyAttempts: requirePositiveInteger(input.write.verifyAttempts, "write.verifyAttempts"),
      firmwareChecks,
      activationPatch,
    },
  };
}

export function rangeContains(range: AddressRange, start: number, end: number): boolean {
  return start >= range.start && end <= range.end;
}

export function rangesOverlap(aStart: number, aEnd: number, b: AddressRange): boolean {
  return aStart < b.end && aEnd > b.start;
}

export function validateWritePlan(profile: DeviceProfile, offset: number, image: Uint8Array): {
  eraseStart: number;
  eraseEnd: number;
} {
  if (!profile.write.enabled) throw new Error("this device profile is read-only");
  if (!image.length) throw new Error("firmware file is empty");
  const imageEnd = offset + image.length;
  if (imageEnd > profile.flash.size) throw new Error("firmware exceeds flash size");
  const eraseStart = offset - (offset % profile.flash.sectorSize);
  const eraseEnd = Math.ceil(imageEnd / profile.flash.sectorSize) * profile.flash.sectorSize;
  if (!profile.write.allowedRanges.some((range) => rangeContains(range, eraseStart, eraseEnd))) {
    throw new Error("sector-aligned erase range is outside every allowed write range");
  }
  const overlap = profile.write.protectedRanges.find((range) => rangesOverlap(eraseStart, eraseEnd, range));
  if (overlap) throw new Error(`sector-aligned erase range overlaps protected region: ${overlap.label}`);
  for (const check of profile.write.firmwareChecks) {
    const actual = image.slice(check.offset, check.offset + check.bytes.length);
    if (actual.length !== check.bytes.length || actual.some((byte, index) => byte !== check.bytes[index])) {
      throw new Error(`firmware check failed: ${check.label}`);
    }
  }
  const patch = profile.write.activationPatch;
  if (patch && patch.offset + patch.to.length > image.length) {
    throw new Error("activation patch is outside the firmware image");
  }
  return { eraseStart, eraseEnd };
}

export function formatHex(value: number, width = 6): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}
