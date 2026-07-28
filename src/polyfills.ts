// @solana/web3.js and friends assume a Node-like environment (Buffer, global)
// that doesn't exist in the browser by default. Imported first in main.tsx,
// before anything that might touch these globals.
import { Buffer } from "buffer";

if (typeof (window as unknown as { Buffer?: unknown }).Buffer === "undefined") {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
if (typeof (window as unknown as { global?: unknown }).global === "undefined") {
  (window as unknown as { global: typeof window }).global = window;
}
