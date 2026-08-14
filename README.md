# Telink Web SWire

A local-first Web Serial programmer for reading, writing, and byte-verifying
SPI flash on Telink TLSR826x devices through their SWire debug interface.

Everything runs in the browser. Firmware files and flash backups are never
uploaded to a server.

> [!WARNING]
> Flash programming can permanently disable a target or destroy device-unique
> settings. Start with a read-only backup, use a narrow device profile, verify
> the wiring and voltage, and test on replaceable hardware first.

## What works

- direct UART-to-SWire framing through a supported USB-UART adapter
- CPU stop, SWire clock setup, and JEDEC identification
- verified flash reads with independent comparison passes
- JSON-defined write and protected ranges
- preservation of bytes outside the firmware image in partially covered sectors
- sector erase, page program, and page-by-page read-back verification
- automatic pre-write backup of every affected sector
- optional separately gated activation patch

TLSR826x is the only chip family implemented in profile schema v1. TLSR825x is
planned but must not be selected through an 826x profile.

## Hardware

The proven direct connection uses a USB-UART adapter whose TX and RX are joined
at the target SWire pin. Put a 1.8 kΩ resistor in the TX path:

```text
USB-UART TX --- 1.8 kΩ ---+--- target SWS
                           |
USB-UART RX ---------------+

USB-UART GND ------------------ target GND
3.3 V supply ------------------ target VCC
```

Do not use 5 V logic. Adapter behavior varies; the upstream project notes that
FTDI devices and adapters with an RX LED load may not work.

## Run locally

Use a current browser with Web Serial support and serve the app from HTTPS or
localhost.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, load or import a profile, then choose the serial
port from the browser permission prompt.

The `main` branch also deploys automatically to GitHub Pages at
`https://nunnun.github.io/telink-web-swire/`.

## Device profiles

Addresses in JSON can be decimal integers or strings such as `"0x34000"`.
The end of every range is exclusive.

```json
{
  "$schema": "https://raw.githubusercontent.com/nunnun/telink-web-swire/main/public/schemas/device-profile.schema.json",
  "schema": "telink-web-swire-device-profile-v1",
  "id": "my-tlsr826x-board",
  "name": "My TLSR826x board",
  "chip": { "family": "tlsr826x", "clockHz": 32000000 },
  "transport": {
    "baudRate": 576000,
    "readTimeoutMs": 250,
    "highSpeedChunkBytes": 60
  },
  "flash": {
    "size": "0x80000",
    "sectorSize": "0x1000",
    "pageSize": "0x100",
    "jedecIds": []
  },
  "cpu": {
    "stopRegister": "0x0602",
    "stopValue": "0x05",
    "stopDurationMs": 2000,
    "resetRegister": "0x006f",
    "resetValue": "0x22"
  },
  "read": { "blockSize": "0x100", "comparePasses": 2, "retries": 5 },
  "write": {
    "enabled": true,
    "defaultOffset": "0x00000",
    "allowedRanges": [
      { "start": "0x00000", "end": "0x34000", "label": "application" }
    ],
    "protectedRanges": [
      { "start": "0x34000", "end": "0x80000", "label": "factory data" }
    ],
    "verifyAttempts": 3,
    "firmwareChecks": []
  }
}
```

The complete schema is in
[`public/schemas/device-profile.schema.json`](public/schemas/device-profile.schema.json).
Every field and address rule is documented in
[`docs/device-profiles.md`](docs/device-profiles.md).
Bundled examples are intentionally plain JSON and contain no firmware,
credentials, MAC addresses, Mesh keys, or flash dumps.

`allowedRanges` is enforced against the complete sector-aligned erase range,
not just the selected image bytes. `protectedRanges` is a second independent
deny-list. A write is rejected unless one allowed range contains the entire
erase range and no protected range overlaps it.

## Safety model

1. Validate the profile, firmware checks, target address, and sector-aligned range.
2. Read every affected sector twice and keep the matching bytes as a backup.
3. Overlay the firmware on that backup so bytes outside the image are preserved.
4. Erase and program one sector at a time.
5. Read every page back and compare it byte-for-byte.
6. Enable an optional activation patch only after all pages verify.

The app deliberately has no chip-erase button.

The bundled generic profile is read-only. Copy it, set `write.enabled` to
`true`, and define narrow `allowedRanges` and `protectedRanges` before writing
an unknown board.

## Origin and license

The UART-to-SWire encoding and TLSR826x flash command sequence are a TypeScript
port derived from
[pvvx/TlsrComSwireWriter](https://github.com/pvvx/TlsrComSwireWriter), commit
`6455f50f25dd264ac6820ecacfd64b90c6c80f3e`, released under the Unlicense.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

New code in this repository is released under the MIT License.
