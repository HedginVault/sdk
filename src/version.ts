/** Must equal `package.json` `version`; `test/version.test.ts` fails the publish otherwise. */
export const SDK_VERSION = "0.7.1";

const parse = (version: string): [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

/** True only when `latest` is a well-formed `x.y.z` above `current`. Anything malformed is ignored. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
