/**
 * Runs once per account and the result is persisted
 * (reddit_accounts.user_agent), so an account always looks like the same
 * iPhone to Reddit.
 */
export function generateUserAgent(random: () => number = Math.random): string {
  // Only the iOS version varies between real iPhones; every other token is frozen
  // by Apple, so randomizing them would fingerprint us instead of blending in.
  const majors = [16, 17, 18, 26] as const;
  const major = majors[Math.floor(random() * majors.length)] ?? 18;
  const minor = Math.floor(random() * 6);

  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${iosOsToken(major, minor)} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${major}.${minor} Mobile/15E148 Safari/604.1`;
}

/**
 * The OS token Safari reports. From iOS 26, Safari freezes it at an iOS 18
 * version (18_6 in 26.0, 18_6_2 in 26.1, 18_7 from 26.2), and only Version/
 * carries the real version. "iPhone OS 26_x" is never sent by a real iPhone.
 */
export function iosOsToken(major: number, minor: number): string {
  if (major < 26) return `${major}_${minor}`;
  if (minor === 0) return "18_6";
  if (minor === 1) return "18_6_2";
  return "18_7";
}
