// Epoch arithmetic. Epoch = calendar month, UTC, written "ep-YYYY-MM"; each epoch has four
// keys with key IDs "ep-YYYY-MM.N", one per metadata value N (protocol.md §3).

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

export function nextEpochIdFor(date: Date = new Date()): string {
  return epochIdFor(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
}

const EPOCH_RE = /^ep-\d{4}-(0[1-9]|1[0-2])$/;
const KEY_ID_RE = /^ep-\d{4}-(0[1-9]|1[0-2])\.[0-3]$/;

export function isValidEpoch(epoch: string): boolean {
  return EPOCH_RE.test(epoch);
}

export function isValidKeyId(kid: string): boolean {
  return KEY_ID_RE.test(kid);
}
