import { Buffer } from "buffer";

// Anchor's decoders (buffer-layout, borsh) and this SDK use the global Buffer, which browsers lack. Set only when missing.
globalThis.Buffer ??= Buffer;
