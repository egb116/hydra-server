import { and, asc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { deviceAccounts, devices, redditAccounts } from "../../db/schema";
import { type SecretBox, redditSecretAad } from "../../lib/crypto";
import type { Deps } from "../../types";
import type { EntitlementService } from "../contracts";
import { pruneLinklessDevices, pruneOrphanAccounts } from "./prune";

/**
 * Most devices one customer keeps; registering another evicts the least
 * recently registered one. Push tokens are free to invent, so without a cap one
 * customer could enroll any number of polled accounts.
 */
export const MAX_DEVICES_PER_CUSTOMER = 3;
/** Most distinct accounts one customer keeps across all of its devices. */
export const MAX_ACCOUNTS_PER_CUSTOMER = 10;

export interface RegisterAccountInput {
  username: string;
  /** The session cookie JSON exactly as the app sent it. */
  session: string;
}

export interface RegisterDeviceInput {
  customerId: string;
  pushToken: string;
  accounts: readonly RegisterAccountInput[];
}

export interface RegisterDeviceResult {
  /** The device row id, or null when the device was deleted (no accounts). */
  deviceId: number | null;
  accountsCreated: number;
  sessionsChanged: number;
  reactivated: number;
  linksRemoved: number;
  /** New accounts not stored because the customer is at MAX_ACCOUNTS_PER_CUSTOMER. */
  accountsSkipped: number;
  /** This customer's least recently registered devices evicted (MAX_DEVICES_PER_CUSTOMER). */
  devicesEvicted: number;
  /** Devices (this one included) left linking to no account, deleted. */
  devicesPruned: number;
  orphansPruned: number;
}

export type RegistrationDeps = Pick<Deps, "db" | "sqlite" | "clock" | "log">;

/**
 * Applies one /api/notifications/register in a single transaction.
 * Only this device's links are
 * touched; other devices of the same customer keep theirs.
 */
export function registerDevice(
  deps: RegistrationDeps,
  services: { entitlements: Pick<EntitlementService, "ensureCustomer">; secretBox: SecretBox },
  input: RegisterDeviceInput,
): RegisterDeviceResult {
  const { db, sqlite, clock, log } = deps;
  const { entitlements, secretBox } = services;
  // The app sends one entry per account; if a name repeats, the last one wins.
  const accounts = [...new Map(input.accounts.map((a) => [a.username, a])).values()];

  const run = sqlite.transaction((): RegisterDeviceResult => {
    const now = clock.now();
    const result: RegisterDeviceResult = {
      deviceId: null,
      accountsCreated: 0,
      sessionsChanged: 0,
      reactivated: 0,
      linksRemoved: 0,
      accountsSkipped: 0,
      devicesEvicted: 0,
      devicesPruned: 0,
      orphansPruned: 0,
    };

    // 1. The customer.
    const customer = entitlements.ensureCustomer(input.customerId);

    // 6 (early). No accounts: the device no longer wants notifications.
    if (accounts.length === 0) {
      db.delete(devices).where(eq(devices.pushToken, input.pushToken)).run();
      result.orphansPruned = pruneOrphanAccounts(sqlite);
      return result;
    }

    // 2. The device, keyed by push token; it follows whichever customer registers it.
    const device = db
      .insert(devices)
      .values({
        pushToken: input.pushToken,
        customerId: customer.id,
        lastRegisteredAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: devices.pushToken,
        set: { customerId: customer.id, lastRegisteredAt: now },
      })
      .returning({ id: devices.id })
      .get();
    result.deviceId = device.id;

    // 2b. Keep at most MAX_DEVICES_PER_CUSTOMER: evict the least recently registered others.
    const others = db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.customerId, customer.id), ne(devices.id, device.id)))
      .orderBy(asc(devices.lastRegisteredAt), asc(devices.id))
      .all();
    const evict = others.slice(0, Math.max(0, others.length - (MAX_DEVICES_PER_CUSTOMER - 1)));
    if (evict.length > 0) {
      result.devicesEvicted = db
        .delete(devices)
        .where(
          inArray(
            devices.id,
            evict.map((d) => d.id),
          ),
        )
        .returning({ id: devices.id })
        .all().length;
    }

    // The customer's accounts other devices keep, for MAX_ACCOUNTS_PER_CUSTOMER.
    const keptByOthers = new Set(
      db
        .select({ accountId: deviceAccounts.accountId })
        .from(deviceAccounts)
        .innerJoin(devices, eq(devices.id, deviceAccounts.deviceId))
        .where(and(eq(devices.customerId, customer.id), ne(devices.id, device.id)))
        .all()
        .map((r) => r.accountId),
    );

    // 3. The accounts, keyed by (customer, username).
    const linked = new Set<number>();
    for (const { username, session } of accounts) {
      const aad = redditSecretAad(customer.id, username);
      const existing = db
        .select()
        .from(redditAccounts)
        .where(
          and(eq(redditAccounts.customerId, customer.id), eq(redditAccounts.username, username)),
        )
        .get();

      if (!existing) {
        if (new Set([...keptByOthers, ...linked]).size >= MAX_ACCOUNTS_PER_CUSTOMER) {
          result.accountsSkipped++;
          continue;
        }
        const row = db
          .insert(redditAccounts)
          .values({
            customerId: customer.id,
            username,
            sessionEnc: secretBox.encryptSecret(session, aad),
            status: "active",
            nextCheckAt: now,
            baselineAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: redditAccounts.id })
          .get();
        linked.add(row.id);
        result.accountsCreated++;
        continue;
      }

      let stored: string | null;
      try {
        stored = secretBox.decryptSecret(existing.sessionEnc, aad);
      } catch (err) {
        // Unreadable (a retired key, or corrupt): the new session replaces it.
        log.warn("stored session could not be decrypted; replacing it", {
          accountId: existing.id,
          err,
        });
        stored = null;
      }
      const sessionChanged = stored !== session;
      const update: Partial<typeof redditAccounts.$inferInsert> = {
        nextCheckAt: Math.min(existing.nextCheckAt, now),
        updatedAt: now,
      };
      if (sessionChanged) {
        update.sessionEnc = secretBox.encryptSecret(session, aad);
        // The token was minted from the old session.
        update.tokenEnc = null;
        update.tokenExpiresAt = null;
        update.sessionFailures = 0;
        result.sessionsChanged++;
      } else if (secretBox.needsReencrypt(existing.sessionEnc)) {
        // Same session in the v1 format or under a previous key: upgrade it while we have the plaintext.
        update.sessionEnc = secretBox.encryptSecret(session, aad);
      }
      if (existing.status === "needs_reauth") {
        update.status = "active";
        update.sessionFailures = 0;
        result.reactivated++;
      }
      db.update(redditAccounts).set(update).where(eq(redditAccounts.id, existing.id)).run();
      linked.add(existing.id);
    }

    // 4. This device's links become exactly the given set.
    const accountIds = [...linked];
    result.linksRemoved = db
      .delete(deviceAccounts)
      .where(
        and(
          eq(deviceAccounts.deviceId, device.id),
          notInArray(deviceAccounts.accountId, accountIds),
        ),
      )
      .returning({ accountId: deviceAccounts.accountId })
      .all().length;
    for (const accountId of linked) {
      db.insert(deviceAccounts)
        .values({ deviceId: device.id, accountId })
        .onConflictDoNothing()
        .run();
    }

    // 5. Devices left with no links (the cap skipped all of their accounts),
    // then accounts no device links any
    // more (removed from the app, or left behind when the device moved to
    // another customer).
    result.devicesPruned = pruneLinklessDevices(sqlite);
    result.orphansPruned = pruneOrphanAccounts(sqlite);
    return result;
  });

  return run.immediate();
}
