/** Formats a base-unit integer string as a display amount without going through `number`. */
export function formatUnits(baseUnits: string, decimals: number): string {
  const value = BigInt(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Parses a display amount such as "1.5" or "1,000" into base units. Rejects more fractional
 * digits than the token has, rather than silently rounding someone's money.
 */
export function parseUnits(display: string, decimals: number): string {
  const text = display.trim().replace(/[,_\s]/g, "");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || text === "" || text === ".") throw new Error(`"${display.trim()}" is not a number`);
  const whole = match[1] || "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`This token has ${decimals} decimals; "${display.trim()}" has more`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString();
}
