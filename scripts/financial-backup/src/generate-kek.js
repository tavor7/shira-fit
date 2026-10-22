import { randomBytes } from "node:crypto";

// Procedure for generating and storing the offline recovery key (KEK) for financial backups.
//
// This script only ever PRINTS a freshly generated key to your terminal -- it never writes it to
// disk, never uploads it, never stores it anywhere itself. That is deliberate: the KEK's only
// copies should be (1) the production secret store (set manually by you, via `supabase secrets
// set` / GitHub Actions secret -- never by this script) and (2) an offline copy you control
// (password manager, printed and secured, hardware token, etc.) -- NOT a third copy sitting in a
// file this tool created.
//
// Phase 1 note: do not use the output of this script as a real production key yet. Run it only
// to produce a disposable TEST key for local restore-test purposes, and discard it afterward.
// Generating and storing the real production KEK is a separate, explicit step for later,
// requiring your own manual custody decision.

const kek = randomBytes(32);
console.log("Generated a new 256-bit key (base64):");
console.log(kek.toString("base64"));
console.log(
  "\nThis value has not been written to any file or sent anywhere by this script.\n" +
    "For a TEST run: paste it into scripts/financial-backup/.env.local as FINANCIAL_BACKUP_TEST_KEK= and discard it when done.\n" +
    "For the real production key (not yet): generate a separate one the same way, store one copy in the production secret store " +
    "and an independent offline copy in your own secure custody (e.g. a password manager), and never let a third copy exist anywhere, including in a terminal scrollback you don't clear."
);
