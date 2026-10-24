import { SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { ApiError } from "../errors";
import type { ExecutionTransport } from "../executor";
import type { BuiltStep, SendResult, TransactionStatus } from "../schemas";
import { type BuildContext, type BuildEnv, buildEnv } from "./context";
import { describeTxFailure } from "./program-errors";
import { isLocalAction, type LocalAction, type LocalBuilders, localBuilders } from "./registry";

/** Local builds skip the API's HMAC ticket; the schema still requires a non-empty one. */
const LOCAL_TICKET = "local";

/** Matches HTTP 429, JSON-RPC -32005 and the usual provider phrasing. */
const isRateLimitError = (message: string) => /\b429\b|-32005|max usage reached|too many requests|rate limit/i.test(message);

/** The local receipt: what `status` needs to tell a pending transaction from an expired one. */
const ReceiptSchema = z.object({ signature: z.string().min(1), blockhash: z.string().min(1) });

const table: LocalBuilders = localBuilders;

async function buildLocal<A extends LocalAction>(env: BuildEnv, action: A, body: Record<string, unknown>): Promise<BuiltStep[]> {
  const builder = table[action];
  const parsed = builder.input.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, "Validation", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const built = await builder.build(env, parsed.data);
  return (Array.isArray(built) ? built : [built]).map((step) => ({ ...step, ticket: LOCAL_TICKET }));
}

/**
 * The provider's simulator crashed rather than the transaction failing: no logs and this message.
 * Resending the same signed bytes cannot execute twice.
 */
const isPreflightInternalError = (e: SendTransactionError) => !e.logs?.length && /internal error during preflight/i.test(e.transactionError.message);

/** `execute`'s build, send and status straight against `ctx.connection`, with no Hedge server. */
export function localTransport(ctx: BuildContext): ExecutionTransport {
  const env = buildEnv(ctx);
  const vaultProgram = ctx.programId.toBase58();
  const { connection } = ctx;

  return {
    build: async (action, body) => {
      if (!isLocalAction(action)) throw new ApiError(404, "NotFound", `${action} has no local builder; use createHedgeClient`);
      if ("payer" in body) throw new ApiError(400, "Validation", "payer is set by the signer");
      return buildLocal(env, action, body);
    },

    /** 1-2 RPC: preflight at `confirmed`, or no preflight when the provider's preflight errors internally. */
    send: async (signedTransactionBase64): Promise<SendResult> => {
      const bytes = Buffer.from(signedTransactionBase64, "base64");
      const tx = VersionedTransaction.deserialize(bytes);
      const signature = bs58.encode(tx.signatures[0] ?? new Uint8Array(64));
      const receipt = JSON.stringify({ signature, blockhash: tx.message.recentBlockhash });
      try {
        let sent: string;
        try {
          sent = await connection.sendRawTransaction(bytes, { preflightCommitment: "confirmed" });
        } catch (e) {
          if (!(e instanceof SendTransactionError && isPreflightInternalError(e))) throw e;
          sent = await connection.sendRawTransaction(bytes, { skipPreflight: true });
        }
        return { signature, receipt, status: sent === signature ? "pending" : "unknown" };
      } catch (e) {
        // web3.js raises SendTransactionError for every JSON-RPC error, rate limits included; those may still have reached the network.
        if (e instanceof SendTransactionError && !isRateLimitError(e.message)) {
          const failure = describeTxFailure(e.logs ?? [], e.transactionError.message, vaultProgram);
          throw new ApiError(422, failure.code ?? "SendFailed", failure.message);
        }
        return { signature, receipt, status: "unknown" };
      }
    },

    /**
     * 1-3 RPC: the signature status; when unknown, whether its blockhash can still land, then one history
     * lookup, since it may have landed in the last valid block; on failure, the logs to decode.
     * Only `confirmed` or better counts: a processed result can still be dropped with its fork.
     */
    status: async (receipt): Promise<TransactionStatus> => {
      let parsed: z.infer<typeof ReceiptSchema>;
      try {
        parsed = ReceiptSchema.parse(JSON.parse(receipt));
      } catch {
        throw new ApiError(400, "Validation", "Not a local transaction receipt");
      }
      const { signature, blockhash } = parsed;
      const lookup = async (searchTransactionHistory = false) =>
        (await connection.getSignatureStatuses([signature], { searchTransactionHistory })).value[0] ?? null;
      let status = await lookup();
      if (!status) {
        const { value: valid } = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" });
        if (valid) return { status: "pending" };
        status = await lookup(true);
        if (!status) return { status: "expired" };
      }
      if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") return { status: "pending" };
      if (!status.err) return { status: "confirmed" };
      const landed = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const failure = describeTxFailure(landed?.meta?.logMessages ?? [], JSON.stringify(status.err), vaultProgram);
      return { status: "failed", code: failure.code ?? "TransactionFailed", message: failure.message };
    },
  };
}
