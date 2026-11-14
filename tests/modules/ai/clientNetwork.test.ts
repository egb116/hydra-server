import { describe, expect, test } from "bun:test";
import { clientNetworkKey } from "../../../src/http/clientIp";
import { clientKeyFor } from "../../../src/modules/ai";
import { expandIpv6 } from "../../../src/http/clientIp";

describe("clientNetworkKey", () => {
  test("IPv4 is unchanged", () => {
    expect(clientNetworkKey("203.0.113.7")).toBe("203.0.113.7");
  });

  test("IPv6 is keyed by its /64", () => {
    expect(clientNetworkKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientNetworkKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(clientNetworkKey("2001:0DB8:0001:0002:0:0:0:c8")).toBe("2001:db8:1:2::/64");
    expect(clientNetworkKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientNetworkKey("2001:db8:1:3::1")).not.toBe(clientNetworkKey("2001:db8:1:2::1"));
    expect(clientNetworkKey("::1")).toBe("0:0:0:0::/64");
  });

  test("IPv4-mapped IPv6 becomes the IPv4 address", () => {
    expect(clientNetworkKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(clientNetworkKey("::ffff:c633:6404")).toBe("198.51.100.4");
  });

  test("non-IPs pass through", () => {
    expect(clientNetworkKey("unknown")).toBe("unknown");
  });

  test("expandIpv6", () => {
    expect(expandIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("64:ff9b::192.0.2.1")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x201]);
    expect(expandIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandIpv6("1:2:3")).toBeNull();
    expect(expandIpv6("1::2::3")).toBeNull();
    expect(expandIpv6("1:2:3:4:5:6:7::8")).toBeNull();
    expect(expandIpv6("::ffff:1.2.3.999")).toBeNull();
  });

  test("clientKeyFor hashes the network, so one /64 gets one key", () => {
    expect(clientKeyFor("2001:db8:1:2::1")).toBe(clientKeyFor("2001:db8:1:2::abcd"));
    expect(clientKeyFor("2001:db8:1:2::1")).not.toBe(clientKeyFor("2001:db8:1:3::1"));
    expect(clientKeyFor("203.0.113.7")).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(clientKeyFor(undefined)).toBeNull();
  });
});
