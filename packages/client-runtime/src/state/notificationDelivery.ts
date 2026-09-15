import * as Schema from "effect/Schema";
import type { AppNotification, NotificationPage } from "@t3tools/contracts";

/** First connection establishes a baseline; reconnect catches up only recent, unread alerts. */
export function consumeNotificationPage(
  cursor: number | null,
  page: typeof NotificationPage.Type,
  now: number,
) {
  if (cursor === null) return { cursor: page.latestSequence, items: [] as AppNotification[] };
  const next =
    page.items.length === 100 ? (page.items.at(-1)?.sequence ?? cursor) : page.latestSequence;
  return {
    cursor: Math.max(cursor, next),
    items: page.items.filter(
      (item) =>
        item.sequence > cursor &&
        item.readAt === null &&
        now - Date.parse(item.createdAt) >= -30_000 &&
        now - Date.parse(item.createdAt) <= 120_000,
    ),
  };
}

const decodeClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String).check(Schema.isMaxLength(200))),
);
/** Call under a Web Lock when available. IDs tolerate sequence resets after a database restore. */
export function claimNotificationDelivery(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key: string,
  id: string,
): boolean {
  let ids: readonly string[] = [];
  try {
    const value = storage.getItem(key);
    if (value) ids = decodeClaims(value);
  } catch {
    /* Private storage or old data can be unavailable. */
  }
  if (ids.includes(id)) return false;
  try {
    storage.setItem(key, JSON.stringify([...ids.slice(-199), id]));
  } catch {
    /* The mounted subscription remains the fallback cursor. */
  }
  return true;
}
