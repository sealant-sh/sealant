import { describe, expect, it } from "vitest";

import {
  cidr,
  cidrContains,
  formatCidr,
  networkOf,
  parseCidr,
  subtractCidrs,
  type Cidr,
} from "./cidr.js";

/** mulberry32: a small seeded generator, so every run checks the same inputs. */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const covers = (blocks: ReadonlyArray<Cidr>, address: Cidr): boolean =>
  blocks.some((block) => cidrContains(block, address));

describe("parseCidr", () => {
  it("reads addresses and blocks of both families, an address being its own /32 or /128", () => {
    expect(formatCidr(cidr("10.0.0.5"))).toBe("10.0.0.5/32");
    expect(formatCidr(cidr("172.16.0.0/12"))).toBe("172.16.0.0/12");
    expect(formatCidr(cidr("0.0.0.0/0"))).toBe("0.0.0.0/0");
    expect(formatCidr(cidr("FD00:EC2::254"))).toBe("fd00:ec2::254/128");
    expect(formatCidr(cidr("fc00::/7"))).toBe("fc00::/7");
    expect(formatCidr(cidr("2001:db8:0:0:1:0:0:1"))).toBe("2001:db8::1:0:0:1/128");
    expect(formatCidr(cidr("::ffff:10.1.2.3"))).toBe("::ffff:a01:203/128");
    expect(formatCidr(cidr("::"))).toBe("::/128");
  });

  it("refuses anything it cannot read exactly, rather than widen or narrow a block", () => {
    for (const text of [
      "",
      "10.0.0",
      "10.0.0.256",
      "010.0.0.1",
      "10.0.0.1/33",
      "10.0.0.1/08",
      "10.0.0.1/",
      "10.0.0.5/8",
      "10.0.0.0/8/8",
      " 10.0.0.1",
      "fe80::1%eth0",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "12345::",
      ":1::",
      "fc00::/129",
      "fc00::1/7",
      "1.2.3.4::",
      "example.com",
    ]) {
      expect(parseCidr(text), text).toBeUndefined();
    }
  });

  it("finds the block an interface address sits in", () => {
    expect(formatCidr(networkOf("10.233.0.18", 28) ?? cidr("0.0.0.0/32"))).toBe("10.233.0.16/28");
    expect(formatCidr(networkOf("fd00:1::5", 64) ?? cidr("::/128"))).toBe("fd00:1::/64");
    expect(networkOf("10.233.0.18", 33)).toBeUndefined();
  });
});

describe("subtractCidrs", () => {
  it("splits a block around a hole into the fewest blocks", () => {
    expect(subtractCidrs([cidr("10.0.0.0/8")], [cidr("10.128.0.0/9")]).map(formatCidr)).toEqual([
      "10.0.0.0/9",
    ]);
    expect(subtractCidrs([cidr("10.0.0.0/30")], [cidr("10.0.0.1")]).map(formatCidr)).toEqual([
      "10.0.0.0/32",
      "10.0.0.2/31",
    ]);
    expect(subtractCidrs([cidr("fc00::/7")], [cidr("fd00::/8")]).map(formatCidr)).toEqual([
      "fc00::/8",
    ]);
    // A hole wider than the block removes it; a hole of the other family leaves it alone.
    expect(subtractCidrs([cidr("10.1.0.0/16")], [cidr("10.0.0.0/8")])).toEqual([]);
    expect(subtractCidrs([cidr("10.1.0.0/16")], [cidr("fc00::/7")]).map(formatCidr)).toEqual([
      "10.1.0.0/16",
    ]);
  });

  it("covers exactly the addresses in some block and in no hole (seeded rule)", () => {
    // Inside one /24 every address can be enumerated, so the rule is checked exactly.
    const random = seeded(0x5ea1a7);
    const block = (): Cidr => {
      const prefix = 24 + Math.floor(random() * 9);
      const size = 2 ** (32 - prefix);
      const offset = Math.floor((random() * 256) / size) * size;
      return cidr(`10.9.8.${String(offset)}/${String(prefix)}`);
    };
    for (let round = 0; round < 300; round += 1) {
      const blocks = Array.from({ length: 1 + Math.floor(random() * 3) }, block);
      const holes = Array.from({ length: Math.floor(random() * 4) }, block);
      const left = subtractCidrs(blocks, holes);
      for (let host = 0; host < 256; host += 1) {
        const address = cidr(`10.9.8.${String(host)}`);
        const expected = covers(blocks, address) && !covers(holes, address);
        expect(covers(left, address), `${host} in ${left.map(formatCidr).join(",")}`).toBe(
          expected,
        );
      }
    }
  });
});
