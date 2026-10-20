// The toast hook (a "type: module" .ts file) and TransactionConfirmation (which reads import.meta.env via
// solana-config) cannot load under this suite's CommonJS ts-node. Render tests only need them to exist,
// so seed the require cache with no-ops before the component loads.
// Import for side effects AFTER ./aliases and BEFORE the component.
import * as path from "path";
import { createRequire } from "module";
const req = createRequire(__filename);
const merge = path.resolve(__dirname, "..", "..", "src", "merge");
const noop = () => ({ id: "", dismiss: () => {}, update: () => {} });
const stub = (rel: string, exports: Record<string, unknown>) => {
  const file = path.join(merge, rel);
  (req.cache as Record<string, unknown>)[file] = { id: file, filename: file, loaded: true, exports };
};
stub(path.join("hooks", "use-toast.ts"), { useToast: () => ({ toast: noop, dismiss: () => {}, toasts: [] }), toast: noop });
stub(path.join("components", "TransactionConfirmation.tsx"), { transactionConfirmedToast: (signature: string, headline = "Transaction confirmed") => ({ title: headline, description: signature }) });
