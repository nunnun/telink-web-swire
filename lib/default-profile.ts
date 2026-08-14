import type { DeviceProfileInput } from "./profile";

/**
 * Synchronous client bootstrap profile. Keep this in sync with
 * public/profiles/tlsr826x-generic-512k.json, which remains downloadable.
 */
export const defaultProfileInput = {
  schema: "telink-web-swire-device-profile-v1",
  id: "tlsr826x-generic-512k",
  name: "TLSR826x Generic 512 KiB",
  description: "Read-only generic TLSR826x profile. Copy it and define narrow write ranges for a known board before enabling writes.",
  chip: {
    family: "tlsr826x",
    clockHz: 32_000_000,
  },
  transport: {
    baudRate: 576_000,
    readTimeoutMs: 250,
    highSpeedChunkBytes: 60,
  },
  flash: {
    size: "0x80000",
    sectorSize: "0x1000",
    pageSize: "0x100",
    jedecIds: [],
  },
  cpu: {
    stopRegister: "0x0602",
    stopValue: "0x05",
    stopDurationMs: 2000,
    resetRegister: "0x006f",
    resetValue: "0x22",
  },
  read: {
    blockSize: "0x100",
    comparePasses: 2,
    retries: 5,
  },
  write: {
    enabled: false,
    defaultOffset: "0x000000",
    allowedRanges: [],
    protectedRanges: [],
    verifyAttempts: 3,
    firmwareChecks: [],
  },
} satisfies DeviceProfileInput;
