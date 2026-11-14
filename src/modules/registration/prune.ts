import type { Database } from "bun:sqlite";
import type { PruneOrphanAccounts } from "../contracts";

/**
 * Deletes every reddit account that no device links to. An account is only ever
 * polled on behalf of a device, so an unlinked row is dead data holding a
 * Reddit session. Run it inside the caller's transaction when there is one.
 */
export const pruneOrphanAccounts: PruneOrphanAccounts = (sqlite: Database) =>
  sqlite.run(
    `DELETE FROM reddit_accounts
     WHERE NOT EXISTS (
       SELECT 1 FROM device_accounts da WHERE da.account_id = reddit_accounts.id
     )`,
  ).changes;

/**
 * Deletes every device that links to no account. Registration leaves one behind
 * when another device's new session drops its links (a new phone logged in
 * again), or when the account cap skipped all of its accounts. Such a device
 * receives nothing until it registers again, which recreates it.
 */
export function pruneLinklessDevices(sqlite: Database): number {
  return sqlite.run(
    `DELETE FROM devices
     WHERE NOT EXISTS (SELECT 1 FROM device_accounts da WHERE da.device_id = devices.id)`,
  ).changes;
}

/**
 * A device that hasn't registered for this long is deleted. The app registers
 * on every cold start while notifications are on, so only a device whose app
 * hasn't been opened for this long (an old phone, or notifications turned off)
 * expires. Opening the app again registers it again.
 */
export const DEVICE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes devices that haven't registered for DEVICE_EXPIRY_MS, then the
 * accounts left without a device (never polled again, so nothing else would
 * remove their sessions). Last, it deletes customers that are not entitled,
 * have no device or account, and haven't changed for as long: lapsed
 * subscribers and ids sent to /api/customers/register by anyone. A returning
 * customer's row is recreated on their next registration.
 */
export function pruneStaleDevices(
  sqlite: Database,
  now: number,
): { devices: number; accounts: number; customers: number } {
  return sqlite.transaction(() => {
    const cutoff = now - DEVICE_EXPIRY_MS;
    const devices = sqlite.run("DELETE FROM devices WHERE last_registered_at < ?1", [
      cutoff,
    ]).changes;
    const accounts = devices > 0 ? pruneOrphanAccounts(sqlite) : 0;
    const customers = sqlite.run(
      `DELETE FROM customers
       WHERE updated_at < ?1
         AND (is_pro = 0 OR (pro_expires_at IS NOT NULL AND pro_expires_at <= ?2))
         AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.customer_id = customers.id)
         AND NOT EXISTS (SELECT 1 FROM reddit_accounts a WHERE a.customer_id = customers.id)`,
      [cutoff, now],
    ).changes;
    return { devices, accounts, customers };
  })();
}
