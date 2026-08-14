# Device profile reference

A device profile is the safety contract between the generic SWire engine and a
specific board or flash layout. The browser validates it before opening a
serial port and again immediately before a write.

JSON addresses may be decimal integers or `0x`-prefixed strings. Range ends are
exclusive, so `0x00000..0x34000` contains `0x34000` bytes and does not include
address `0x34000`.

## Identity and transport

| Field | Meaning |
| --- | --- |
| `schema` | Must be `telink-web-swire-device-profile-v1`. |
| `id` | Stable lowercase identifier used in backup filenames. |
| `chip.family` | `tlsr826x` in schema v1. |
| `chip.clockHz` | Running target clock used to calculate the SWire divider. |
| `transport.baudRate` | USB-UART baud rate. The proven CP2102 setting is `576000`. |
| `transport.readTimeoutMs` | Maximum wait for one serial response. |
| `transport.highSpeedChunkBytes` | UART write chunk size above 460800 baud; must be a multiple of ten SWire symbols. |

## Flash geometry and probe

| Field | Meaning |
| --- | --- |
| `flash.size` | Complete addressable SPI flash size. |
| `flash.sectorSize` | Erase sector size, normally `0x1000`. |
| `flash.pageSize` | Page-program size, at most `0x100` for TLSR826x. |
| `flash.jedecIds` | Optional list of permitted three-byte JEDEC IDs. An empty list accepts any nonzero/non-`ffffff` response. |

## CPU control

`cpu.stopRegister`, `cpu.stopValue`, and `cpu.stopDurationMs` define how the
target is halted before flash access. `cpu.resetRegister` and `cpu.resetValue`
define the explicit **Reset CPU** operation. Neither action changes flash.

## Verified reads

`read.blockSize` is the amount accepted at a time. With `comparePasses: 2`,
each block is read in two independent SPI transactions and accepted only when
the bytes match. `read.retries` is the maximum number of comparison attempts.

## Write policy

`write.enabled` is the master switch. A generic or unknown board should ship
with it set to `false`.

`write.defaultOffset` is the initial **Write offset** shown in the UI. It is
the absolute flash address where firmware file byte zero will be placed. The
operator may change it, but all safety checks are rerun for the new value.

`write.allowedRanges` is an allow-list. One entry must contain the *complete
sector-aligned erase range*. For example, a 100-byte image written at `0x33ff0`
touches sectors through `0x34fff`; a range ending at `0x34000` correctly rejects
that operation.

`write.protectedRanges` is an independent deny-list. Any overlap rejects the
write even if an allowed range also contains it. Use it for active banks, boot
metadata, MAC addresses, pairing keys, calibration, and persistent settings.

`write.verifyAttempts` controls page read-back retries. A write succeeds only
after every page compares byte-for-byte.

## Firmware checks

Each `write.firmwareChecks` entry compares fixed bytes before hardware access:

```json
{
  "offset": "0x8",
  "hex": "ff4e4c54",
  "label": "inactive FFNLT marker"
}
```

The offset is relative to the firmware file, not the flash. Checks can enforce
magic values, inactive markers, or format versions. Avoid checks containing
device credentials.

## Activation patch

An optional activation patch is deliberately excluded from the main write:

```json
{
  "offset": "0x8",
  "fromHex": "ff",
  "toHex": "4b",
  "label": "change FFNLT to KNLT"
}
```

Its offset is relative to the firmware file. The absolute address is the
successful write offset plus this value. The patch becomes available only
after the complete image verifies, requires a second confirmation, checks the
`fromHex` precondition, and verifies `toHex` afterward. It may only clear flash
bits from 1 to 0; a 0-to-1 change would require a sector erase and is rejected.

## Review checklist

- Confirm flash size, sector size, page size, target clock, and JEDEC ID.
- Make the allowed range as narrow as the proven application slot.
- Protect all other banks and device-unique sectors explicitly.
- Ensure allowed/protected boundaries are sector-aligned.
- Add a firmware magic or inactive-marker check when the format provides one.
- Test read-only first, then test writes on replaceable hardware.
- Never put a real flash dump, MAC, key, or credential in a public profile.
