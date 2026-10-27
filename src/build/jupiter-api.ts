import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { ApiError } from "../errors";
import type { Quote } from "../schemas";
import { pubkey } from "./context";

/** Jupiter's Swap API v1, as the app's `server/prices.ts` configures it. */
export interface JupiterConfig {
  host: string;
  apiKey?: string;
}

export const jupiterConfig = (apiKey?: string, host?: string): JupiterConfig => {
  const key = apiKey?.trim() || undefined;
  return { host: host?.trim() || (key ? "https://api.jup.ag" : "https://lite-api.jup.ag"), ...(key && { apiKey: key }) };
};

const headers = ({ apiKey }: JupiterConfig): Record<string, string> => ({ "Content-Type": "application/json", ...(apiKey && { "x-api-key": apiKey }) });

const baseUnits = z.string().regex(/^\d+$/);

const QuoteResponseSchema = z.object({
  inAmount: baseUnits,
  outAmount: baseUnits,
  priceImpactPct: z.string(),
  routePlan: z.array(z.object({ swapInfo: z.object({ label: z.string() }) })),
});

const InstructionSchema = z.object({
  programId: pubkey,
  accounts: z.array(z.object({ pubkey, isSigner: z.boolean(), isWritable: z.boolean() })),
  data: z.string().base64(),
});
export type JupiterInstruction = z.infer<typeof InstructionSchema>;

const SwapInstructionsSchema = z.object({
  swapInstruction: InstructionSchema,
  tokenLedgerInstruction: InstructionSchema.nullish(),
  setupInstructions: z.array(InstructionSchema).default([]),
  cleanupInstruction: InstructionSchema.nullish(),
  addressLookupTableAddresses: z.array(pubkey),
});
export type SwapInstructions = z.infer<typeof SwapInstructionsSchema>;

/** A parsed quote, and the untouched response that `/swap-instructions` takes back. */
export interface JupiterQuote {
  raw: unknown;
  view: Omit<Quote, "slippageBps">;
}

export interface QuoteParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  slippageBps: number;
  excludeDexes: string[];
  maxAccounts: number;
}

type Http = { fetch: typeof fetch; jupiter: JupiterConfig };

/** One HTTP call. Network errors, non-2xx and malformed bodies all become `ApiError`s, so a build never half-completes. */
async function call<T extends z.ZodTypeAny>(
  env: Http,
  path: string,
  init: RequestInit,
  schema: T,
  failure: { code: string; message: string; noRoute?: string },
): Promise<{ raw: unknown; data: z.infer<T> }> {
  let res: Response;
  try {
    res = await env.fetch(`${env.jupiter.host}/swap/v1${path}`, { ...init, headers: headers(env.jupiter) });
  } catch {
    throw new ApiError(502, failure.code, failure.message);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const noRoute = failure.noRoute && /NO_ROUTES_FOUND|COULD_NOT_FIND_ANY_ROUTE/.test(detail);
    throw new ApiError(502, failure.code, noRoute ? (failure.noRoute ?? failure.message) : failure.message);
  }
  const endpoint = path.split("?")[0];
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ApiError(502, "JupiterBadResponse", `Jupiter returned a response that is not JSON (${endpoint})`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(502, "JupiterBadResponse", `Jupiter returned an unexpected response (${endpoint})`);
  return { raw, data: parsed.data };
}

/** `GET /quote`, ExactIn. */
export async function requestQuote(env: Http, p: QuoteParams): Promise<JupiterQuote> {
  const query = new URLSearchParams({
    inputMint: p.inputMint.toBase58(),
    outputMint: p.outputMint.toBase58(),
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    swapMode: "ExactIn",
    excludeDexes: p.excludeDexes.join(","),
    maxAccounts: String(p.maxAccounts),
  });
  const { raw, data } = await call(env, `/quote?${query}`, {}, QuoteResponseSchema, {
    code: "JupiterQuoteFailed",
    message: "Jupiter could not quote this swap right now. Try again in a moment.",
    noRoute: "Jupiter found no swap route for this pair and amount. Try a different amount or token.",
  });
  const routeLabels = data.routePlan.map((r) => r.swapInfo.label);
  return { raw, view: { inAmount: data.inAmount, outAmount: data.outAmount, priceImpactPct: data.priceImpactPct, routeLabels } };
}

/** `POST /swap-instructions` for a quote, swapping as `user`, a program PDA that signs inside the CPI. */
export const requestSwapInstructions = async (
  env: Http,
  quote: JupiterQuote,
  user: PublicKey,
  destinationTokenAccount: PublicKey,
  useTokenLedger: boolean,
): Promise<SwapInstructions> =>
  (await call(
    env,
    "/swap-instructions",
    {
      method: "POST",
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey: user.toBase58(),
        destinationTokenAccount: destinationTokenAccount.toBase58(),
        // A program PDA, not the manager wallet, signs the Jupiter CPI. Shared-account routes can
        // forward a separate `real_user` to newer AMMs and lose that PDA signer privilege.
        useSharedAccounts: false,
        wrapAndUnwrapSol: false,
        dynamicSlippage: false,
        useTokenLedger,
      }),
    },
    SwapInstructionsSchema,
    { code: "JupiterSwapFailed", message: "Jupiter could not build this swap right now. Try again in a moment." },
  )).data;

export const toInstruction = (ix: JupiterInstruction) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
