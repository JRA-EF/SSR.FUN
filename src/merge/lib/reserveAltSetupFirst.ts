// DEC-0293: the one-time lookup-table setup of a Reserve is signed in its OWN
// wallet prompt and confirmed before the mint or redemption is built.
//
// Why. The server prepends "alt-create" + "alt-extend" to the first mint or
// redemption of a Reserve that has no lookup table yet, and every other
// transaction in that batch references the table. Phantom checks every
// transaction of a sign-all prompt before showing it; a transaction that
// loads a table which does not exist yet cannot be checked, so Phantom
// answered "security verification failed -- server error" and offered only
// Close (SAIR #92, 2026-11-14: the creator could neither mint nor redeem).
// Landing the setup first, then rebuilding, means the main prompt only holds
// transactions that load an existing table.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { registerReserveAlt } from "./reserveAltClient";

export const isAltSetupKind = (kind: string): boolean => kind === "alt-create" || kind === "alt-extend";

/** A lookup table only becomes referenceable once the chain has advanced past the slot of its last extension -- bounded wait for it to be fully readable and active. */
export async function waitForLookupTable(connection: Connection, table: PublicKey, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await connection.getAddressLookupTable(table).catch(() => null);
    if (res?.value?.isActive()) {
      const slotNow = await connection.getSlot("confirmed").catch(() => 0);
      if (slotNow > res.value.state.lastExtendedSlot) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Bounded wait until the table account is readable at all (after its creation lands). */
export async function waitForTableExists(connection: Connection, table: PublicKey, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await connection.getAddressLookupTable(table).catch(() => null);
    if (res?.value) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export interface AltSetupTx {
  kind: string;
  base64: string;
  lastValidBlockHeight: number;
}

export interface AltSetupDeps {
  connection: Connection;
  reserve: string;
  /** Signs exactly these transactions in one wallet prompt. */
  signMany(txs: VersionedTransaction[]): Promise<VersionedTransaction[]>;
  /** Sends one signed transaction and resolves once it is confirmed (throws otherwise). */
  submitAndConfirm(tx: VersionedTransaction, lastValidBlockHeight: number, what: string): Promise<void>;
  waitForTable?: (connection: Connection, table: PublicKey) => Promise<void>;
  waitForTableExists?: (connection: Connection, table: PublicKey) => Promise<void>;
  register?: (reserve: string, alt: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * If `build` carries setup transactions: sign them alone, land them in order,
 * wait for the table, register it, and return a fresh build from `rebuild`
 * that no longer carries setup. Otherwise returns `build` unchanged.
 */
export async function landAltSetupThenRebuild<B extends { transactions: AltSetupTx[]; altToRegister: string | null }>(
  build: B,
  rebuild: () => Promise<B>,
  deps: AltSetupDeps,
): Promise<B> {
  const setup = build.transactions.filter((t) => isAltSetupKind(t.kind));
  if (setup.length === 0) return build;
  const sleep = deps.sleep ?? defaultSleep;
  const register = deps.register ?? registerReserveAlt;
  const decode = (t: AltSetupTx) => VersionedTransaction.deserialize(Buffer.from(t.base64, "base64"));

  // One approval per setup transaction: the extension loads the table the
  // creation makes, so a wallet could not check both in one prompt either.
  for (const t of setup) {
    const [signed] = await deps.signMany([decode(t)]);
    await deps.submitAndConfirm(signed, t.lastValidBlockHeight, t.kind === "alt-create" ? "the lookup table creation" : "the lookup table extension");
    // The extension is pre-checked against the table; an RPC node that has not
    // seen the creation yet refuses it ("Invalid account owner").
    if (t.kind === "alt-create" && build.altToRegister && setup.length > 1) {
      await (deps.waitForTableExists ?? waitForTableExists)(deps.connection, new PublicKey(build.altToRegister));
    }
  }
  if (build.altToRegister) {
    await (deps.waitForTable ?? waitForLookupTable)(deps.connection, new PublicKey(build.altToRegister));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await register(deps.reserve, build.altToRegister);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        deps.log?.("lookup table registration failed, retrying", { attempt: attempt + 1, error: String(e) });
        await sleep(1_500);
      }
    }
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // The server reads the registered table from chain; give its RPC a moment if it lags.
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = await rebuild();
    if (!next.transactions.some((t) => isAltSetupKind(t.kind))) return next;
    deps.log?.("rebuild still carries table setup, waiting for the server to see the table", { attempt: attempt + 1 });
    await sleep(1_500);
  }
  throw new Error("The one-time setup for this Reserve landed, but the server does not see its lookup table yet. Wait a minute and try again -- nothing else was submitted.");
}
