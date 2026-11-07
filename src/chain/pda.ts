import { PublicKey } from "@solana/web3.js";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const find = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) => PublicKey.findProgramAddressSync(seeds, programId)[0];

export const getConfigPda = (programId: PublicKey) => find([Buffer.from("config")], programId);
export const getShareMintPda = (vault: PublicKey, programId: PublicKey) => find([Buffer.from("share_mint"), vault.toBuffer()], programId);
/** The associated token account of `owner` for `mint`; `owner` may be a PDA such as a vault. */
export const getAssociatedTokenAddress = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  find([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
/** The Metaplex metadata account of a mint, where a vault's share token keeps its symbol. */
export const getMetadataPda = (mint: PublicKey) =>
  find([Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], METADATA_PROGRAM_ID);
export const getDepositRequestPda = (vault: PublicKey, depositor: PublicKey, programId: PublicKey) =>
  find([Buffer.from("deposit_request"), vault.toBuffer(), depositor.toBuffer()], programId);
export const getWithdrawalRequestPda = (vault: PublicKey, withdrawer: PublicKey, programId: PublicKey) =>
  find([Buffer.from("withdrawal_request"), vault.toBuffer(), withdrawer.toBuffer()], programId);
