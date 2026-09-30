// Per-client, per-UTC-day issuance quota (protocol.md §5: DAILY_QUOTA = 64
// blinded messages/client/day; hard 429 beyond it).
//
// This default store is process-local and loses usage on restart. Production
// integrations must supply a durable QuotaStore shared by replicas, with an
// atomic limit check and reservation of the entire batch.

export interface QuotaStore {
  /** Atomically reserve a whole batch. Return false without changing the counter. */
  take(clientId: string, count: number, now: Date): boolean | Promise<boolean>;
}

export class DailyQuota implements QuotaStore {
  private days = new Map<number, Map<string, number>>();
  private newestDay = -Infinity;

  constructor(private limit: number = 64) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new Error('quota must be an integer from 1 to 64');
    }
  }

  /** Atomically consume `n` from the client's daily allowance.
   *  Returns false (and consumes nothing) if that would exceed the limit. */
  take(clientId: string, n: number, now: Date = new Date()): boolean {
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new Error('count must be a positive integer');
    }

    const day = Math.floor(now.getTime() / 86_400_000);
    if (!Number.isFinite(day)) {
      throw new Error('invalid quota timestamp');
    }

    if (day > this.newestDay) {
      this.newestDay = day;
      for (const savedDay of this.days.keys()) {
        if (savedDay < day - 1) {
          this.days.delete(savedDay);
        }
      }
    }

    // Requests can finish out of order at midnight. Keep yesterday's counter;
    // never reset today's allowance when an older request reaches the store.
    if (day < this.newestDay - 1) {
      return false;
    }

    const used = this.days.get(day) ?? new Map<string, number>();
    const current = used.get(clientId) ?? 0;
    if (current + n > this.limit) {
      return false;
    }

    used.set(clientId, current + n);
    this.days.set(day, used);

    return true;
  }
}
