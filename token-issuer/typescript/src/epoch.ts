// Epoch arithmetic. Epoch = calendar month, UTC; key id "ep-YYYY-MM"
// (protocol.md §3). Nothing here touches keys — see keys.ts.

export function epochIdFor(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');

  return `ep-${y}-${m}`;
}

export function previousEpochIdFor(date: Date = new Date()): string {
  // Day 1 of the current UTC month, minus one month. Date.UTC normalizes
  // month -1 across year boundaries.
  return epochIdFor(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

const KID_RE = /^ep-\d{4}-(0[1-9]|1[0-2])$/;

export function isValidKid(kid: string): boolean {
  return KID_RE.test(kid);
}
