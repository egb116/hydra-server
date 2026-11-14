import { describe, expect, test } from "bun:test";
import { generateUserAgent, iosOsToken } from "../../../src/modules/reddit/userAgent";

describe("generateUserAgent", () => {
  test("iOS 18 and earlier report their own version in both tokens", () => {
    // random() = 0.6 picks majors[2] = 18 and minor 3.
    expect(generateUserAgent(() => 0.6)).toBe(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    );
  });

  test("iOS 26 freezes the OS token at an iOS 18 version, as Safari does", () => {
    expect(iosOsToken(26, 0)).toBe("18_6");
    expect(iosOsToken(26, 1)).toBe("18_6_2");
    expect(iosOsToken(26, 4)).toBe("18_7");
    const ua = generateUserAgent(() => 0.9);
    expect(ua).toContain("Version/26.5");
    expect(ua).toContain("iPhone OS 18_7 like");
  });

  test("never emits an OS token of 26 or later", () => {
    for (let i = 0; i < 200; i++) {
      const r = i / 200;
      expect(generateUserAgent(() => r)).not.toMatch(/iPhone OS 2\d_/);
    }
  });
});
