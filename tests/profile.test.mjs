import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseProfile, validateWritePlan } from "../lib/profile.ts";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../public/profiles/${name}`, import.meta.url), "utf8"));
}

test("generic bundled profile is read-only", async () => {
  const profile = parseProfile(await fixture("tlsr826x-generic-512k.json"));
  assert.throws(() => validateWritePlan(profile, 0x1000, new Uint8Array(0x1234)), /read-only/);
});

test("ES-B01CW profile requires the inactive marker", async () => {
  const profile = parseProfile(await fixture("es-b01cw-bank-a.json"));
  const image = new Uint8Array(0x2000).fill(0xff);
  image.set([0xff, 0x4e, 0x4c, 0x54], 8);
  assert.deepEqual(validateWritePlan(profile, 0, image), {
    eraseStart: 0,
    eraseEnd: 0x2000,
  });
  image[8] = 0x4b;
  assert.throws(() => validateWritePlan(profile, 0, image), /inactive FFNLT marker/);
});

test("ES-B01CW profile rejects an erase that reaches a protected region", async () => {
  const profile = parseProfile(await fixture("es-b01cw-bank-a.json"));
  const image = new Uint8Array(0x34001).fill(0xff);
  image.set([0xff, 0x4e, 0x4c, 0x54], 8);
  assert.throws(() => validateWritePlan(profile, 0, image), /outside every allowed write range/);
});

test("activation patch can only clear flash bits", async () => {
  const input = await fixture("es-b01cw-bank-a.json");
  input.write.activationPatch = { offset: "0x8", fromHex: "00", toHex: "ff", label: "unsafe" };
  assert.throws(() => parseProfile(input), /only change flash bits from 1 to 0/);
});

test("activation patch must target bytes inside the firmware image", async () => {
  const input = await fixture("es-b01cw-bank-a.json");
  input.write.activationPatch.offset = "0x100";
  const profile = parseProfile(input);
  const image = new Uint8Array(0x100).fill(0xff);
  image.set([0xff, 0x4e, 0x4c, 0x54], 8);
  assert.throws(() => validateWritePlan(profile, 0, image), /activation patch is outside/);
});
