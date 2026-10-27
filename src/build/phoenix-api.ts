import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { ApiError } from "../errors";
import type { ExecutionTransport } from "../executor";
import type { SendResult } from "../schemas";
import { assertOperator, type BuildContext, buildEnv, DELEGATE_PHOENIX, delegateFor, loadVaultCtx, pubkey } from "./context";
import { getPhoenixTraderAddress, isTraderReady, unavailable } from "./phoenix-accounts";
import { localTransport } from "./transport";

export const DEFAULT_PHOENIX_API_URL = "https://perp-api.phoenix.trade";
const MAX_POSITIONS = 128;
const TIMEOUT_MS = 15_000;

/** The fields of perp-api's market list the builders read. */
const MarketSchema = z.object({
  symbol: z.string(),
  assetId: z.number().int().nonnegative(),
  marketPubkey: pubkey,
  tickSize: z.number().int().positive(),
  baseLotsDecimals: z.number().int(),
});
export type PhoenixMarket = z.infer<typeof MarketSchema>;

const RegisterIxsSchema = z.object({
  instructions: z.array(
    z.object({
      programId: pubkey,
      data: z.array(z.number().int().min(0).max(255)),
      keys: z.array(z.object({ pubkey, isSigner: z.boolean(), isWritable: z.boolean() })),
    }),
  ),
});

type Http = Pick<BuildContext, "fetch" | "phoenixApiUrl">;

/** Network errors and non-2xx become `PhoenixUnavailable`, a body that is not the expected JSON `PhoenixBadResponse`. */
async function call<T extends z.ZodTypeAny>(env: Http, path: string, schema: T, body?: object): Promise<z.infer<T>> {
  let res: Response;
  try {
    res = await env.fetch(`${env.phoenixApiUrl}${path}`, {
      ...(body && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw unavailable(`${path} unreachable`);
  }
  if (!res.ok) throw unavailable(`${path} returned ${res.status}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ApiError(502, "PhoenixBadResponse", `Phoenix returned a response that is not JSON (${path})`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(502, "PhoenixBadResponse", `Phoenix returned an unexpected response (${path})`);
  return parsed.data;
}

/** One perp-api call per build: a market's static parameters by symbol. */
export async function resolvePhoenixMarket(env: Http, symbol: string): Promise<PhoenixMarket> {
  const markets = await call(env, "/v1/view/exchange/markets", z.array(z.object({ symbol: z.unknown() }).passthrough()));
  // Only the requested row is parsed in full, so an odd market elsewhere in the list cannot block trading this one.
  const row = markets.find((m) => m.symbol === symbol);
  if (row === undefined) throw new ApiError(400, "Validation", `Unknown Phoenix market ${symbol}`);
  const market = MarketSchema.safeParse(row);
  if (!market.success) throw new ApiError(502, "PhoenixBadResponse", "Phoenix returned an unexpected response (/v1/view/exchange/markets)");
  return market.data;
}

/** The local receipt `localTransport().status` reads. */
const receiptOf = (tx: VersionedTransaction) => {
  const signature = bs58.encode(tx.signatures[0] ?? new Uint8Array(64));
  return { signature, receipt: JSON.stringify({ signature, blockhash: tx.message.recentBlockhash }) };
};

/**
 * `onboardPhoenix`'s transport. `build` asks Phoenix for the vault trader's registration (Path A), paid by
 * `ctx.payer`; `send` hands the signed transaction to Phoenix, whose onboarder co-signs and broadcasts it;
 * `status` polls `ctx.connection`. The executor's onboarding inspector, not this builder, refuses any
 * instruction outside the Phoenix program.
 */
export function phoenixOnboardTransport(ctx: BuildContext, vaultAddress: string): ExecutionTransport {
  const env = buildEnv(ctx);
  const register = { traderAuthority: vaultAddress, txFeePayer: ctx.payer.toBase58(), maxPositions: MAX_POSITIONS };
  return {
    build: async () => {
      const vault = await loadVaultCtx(env, vaultAddress);
      // Phoenix's own instructions take no delegate account; the vault's Phoenix permission still applies.
      delegateFor(await assertOperator(env, vault, ctx.payer), DELEGATE_PHOENIX);
      const trader = await ctx.connection.getAccountInfo(getPhoenixTraderAddress(vault.key));
      if (trader && isTraderReady(trader)) throw new ApiError(409, "PhoenixAlreadyOnboarded", "The vault's Phoenix trader is already onboarded");
      const built = await call(ctx, "/v1/exchange/build-register-ixs", RegisterIxsSchema, register);
      if (built.instructions.length === 0) throw new ApiError(502, "PhoenixBadResponse", "Phoenix returned no onboarding instructions");
      const instructions = built.instructions.map(
        (ix) =>
          new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
            data: Buffer.from(ix.data),
          }),
      );
      // Not simulated: the onboarder's signature is still missing.
      const { blockhash } = await ctx.connection.getLatestBlockhash("confirmed");
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: ctx.payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
      return [{ transaction: Buffer.from(tx.serialize()).toString("base64"), simulation: { unitsConsumed: 0, deferred: true }, ticket: "local", blockhash }];
    },

    /**
     * Phoenix broadcasts, so only its 4xx proves nothing was sent. A timeout, 5xx, unreadable body or other
     * signature may have been broadcast, and the receipt lets `status` settle it on chain.
     */
    send: async (signedTransactionBase64): Promise<SendResult> => {
      const { signature, receipt } = receiptOf(VersionedTransaction.deserialize(Buffer.from(signedTransactionBase64, "base64")));
      const unknown: SendResult = { signature, receipt, status: "unknown" };
      let res: Response;
      try {
        res = await ctx.fetch(`${ctx.phoenixApiUrl}/v1/exchange/send-register-ixs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transaction: signedTransactionBase64, ...register, traderPdaIndex: 0, traderSubaccountIndex: 0 }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return unknown;
      }
      if (res.status >= 400 && res.status < 500) throw new ApiError(422, "PhoenixRejected", `Phoenix rejected the onboarding transaction (${res.status})`);
      const sent = z.object({ signature: z.string() }).safeParse(await res.json().catch(() => undefined));
      return res.ok && sent.success && sent.data.signature === signature ? { ...unknown, status: "pending" } : unknown;
    },

    status: localTransport(ctx).status,
  };
}
