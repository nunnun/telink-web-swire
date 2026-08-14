import assert from "node:assert/strict";
import test from "node:test";
import { decodeSwire, encodeSwire, SwireBus } from "../lib/swire.ts";

test("SWire encoding emits one start, eight data, and one stop symbol per byte", () => {
  assert.deepEqual(
    [...encodeSwire([0xa5])],
    [0x80, 0x80, 0xfe, 0x80, 0xfe, 0xfe, 0x80, 0xfe, 0x80, 0xfe],
  );
});

test("register write uses an independently started SWire end command", async () => {
  const writes = [];
  const transport = { writeEcho: async (data) => writes.push(data) };
  const bus = new SwireBus(transport);
  await bus.writeRegister(0x0602, [0x05]);
  const body = encodeSwire([0x5a, 0x06, 0x02, 0x00, 0x05]);
  const end = encodeSwire([0xff]);
  assert.deepEqual([...writes[0]], [...body, ...end]);
  assert.equal(writes[0][body.length], 0x80);
});

test("SWire decoder rejects a malformed stop symbol", () => {
  assert.throws(() => decodeSwire(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0)), /invalid SWire/);
});
