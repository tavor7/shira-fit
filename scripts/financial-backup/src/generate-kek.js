import { randomBytes } from "node:crypto";

// Procedure for generating a key to decrypt/create a LEGACY (Phase 1-3) application-level
// encrypted backup. As of the current backup format, financial backups are stored unencrypted
// in R2 (relying on R2's provider-managed encryption at rest, private bucket access, and TLS --
// see README.md "Encryption"), so this script is no longer part of the normal backup/restore
// path. It remains only to (a) restore a legacy encrypted backup that predates that change, or
// (b) generate a disposable test key if you need to exercise the legacy code path in restore.js.
//
// This script only ever PRINTS a freshly generated key to your terminal -- it never writes it to
// disk, never uploads it, never stores it anywhere itself.

const kek = randomBytes(32);
console.log("Generated a new 256-bit key (base64):");
console.log(kek.toString("base64"));
console.log(
  "\nThis value has not been written to any file or sent anywhere by this script.\n" +
    "For a TEST run: paste it into scripts/financial-backup/.env.local as FINANCIAL_BACKUP_TEST_KEK= and discard it when done.\n" +
    "For the real production key (not yet): generate a separate one the same way, store one copy in the production secret store " +
    "and an independent offline copy in your own secure custody (e.g. a password manager), and never let a third copy exist anywhere, including in a terminal scrollback you don't clear."
);
