import { PublicKey } from "@solana/web3.js";
import { HEDGE_VAULT_PROGRAM_ID } from "../signer";

const DEFAULT_PROGRAM_ID = new PublicKey(HEDGE_VAULT_PROGRAM_ID);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const find = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const u64Le = (value: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

export const getConfigPda = (programId = DEFAULT_PROGRAM_ID) => find([Buffer.from("config")], programId);
export const getManagerPda = (authority: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("manager"), authority.toBuffer()], programId);
export const getVaultPda = (id: bigint, programId = DEFAULT_PROGRAM_ID) => find([Buffer.from("vault"), u64Le(id)], programId);
export const getShareMintPda = (vault: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("share_mint"), vault.toBuffer()], programId);
export const getDepositEscrowPda = (vault: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("deposit_escrow"), vault.toBuffer()], programId);
export const getShareEscrowPda = (vault: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("share_escrow"), vault.toBuffer()], programId);
export const getDelegatePda = (vault: PublicKey, wallet: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("delegate"), vault.toBuffer(), wallet.toBuffer()], programId);
export const getStrategyPda = (vault: PublicKey, protocolAccount: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("strategy"), vault.toBuffer(), protocolAccount.toBuffer()], programId);
/** The wallet-like signer a vault swaps through on venues that reject the vault account itself. */
export const getSwapAuthorityPda = (vault: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("swap_authority"), vault.toBuffer()], programId);
export const getDepositRequestPda = (vault: PublicKey, authority: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("deposit_request"), vault.toBuffer(), authority.toBuffer()], programId);
export const getWithdrawalRequestPda = (vault: PublicKey, authority: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("withdrawal_request"), vault.toBuffer(), authority.toBuffer()], programId);
export const getUnwrapPda = (withdrawalRequest: PublicKey, programId = DEFAULT_PROGRAM_ID) =>
  find([Buffer.from("unwrap"), withdrawalRequest.toBuffer()], programId);
/** The associated token account of `owner` for `mint`; `owner` may be a PDA such as a vault. */
export const getAssociatedTokenAddress = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  find([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
