# Shira Fit — Project Summary

Use this document for resumes, portfolios, and interviews. For setup and development, see [README.md](./README.md).

## One-liner

Bilingual (English/Hebrew, RTL) fitness-studio operations platform — session registration, billing, Israeli digital receipts, and staff tooling — built with **React Native (Expo) + Supabase**.

## Problem

Fitness studios run on tight schedules: athletes register for group sessions, coaches manage rosters on training days, and managers handle approvals, pricing, payments, and compliance. Spreadsheets and ad-hoc messaging create missed sessions, billing errors, and stressful day-of workflows.

## Solution

Shira Fit is a cross-platform app (iOS, Android, and static web PWA) that centralizes the full studio lifecycle: discovery → registration → waitlist → attendance → payments → receipts → reporting. Business rules live in PostgreSQL (RLS + RPCs), not only in the client.

## Users & roles

| Role | Device | Responsibilities |
|------|--------|------------------|
| **Athlete** | Mobile | Browse sessions, register/waitlist/cancel, view schedule, manage profile and legal consents |
| **Coach** | Mobile | Manage own sessions, attendance, roster, payments, notes, manual participants |
| **Manager** | Web PWA + mobile | Studio-wide control: approvals, scheduling, finance, receipts, reports, staff tools, WhatsApp rollout |

## Tech stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | React Native 0.83, Expo SDK 55, Expo Router, TypeScript, React 19 |
| **Backend** | Supabase (PostgreSQL, Auth, RLS, RPCs, Storage, Vault, pg_net, pg_cron) |
| **Edge compute** | 7 Supabase Edge Functions (Deno) |
| **Auth** | Supabase email/password; secure token storage (expo-secure-store / localStorage) |
| **Push** | Expo Notifications + Expo push tokens |
| **Email** | Resend (receipt/document delivery) |
| **WhatsApp** | Meta WhatsApp Business API (template messages, rollout modes) |
| **PDF** | pdf-lib with embedded Noto Sans Hebrew (RTL receipts) |
| **Hosting** | Static Expo web export → Render, Vercel, or Netlify |
| **i18n** | English + Hebrew with full RTL support |

## Key features

### Session operations
- Weekly session calendar (Sun–Sat studio week, Asia/Jerusalem timezone)
- Registration, waitlist (FIFO), and cancellation with server-enforced capacity
- 24-hour late-cancel charge rule
- Configurable weekly registration opening (automated via cron + Edge Function)
- Waitlist push notifications when spots open (pg_net triggers → Edge Function)
- Recurring session series, hidden sessions, manual participants
- Attendance tracking, no-show/late-cancel billing, session notes

### Finance & pricing
- Per-session billing with capacity-tier pricing hierarchy
- Coach payout tiers by registered headcount
- Account-level payments (cash, PayBox, Bit, bank transfer, etc.)
- Manager finance dashboard (weekly/monthly/global views, expected vs collected)
- Capacity mismatch detection and coach session earnings reports

### Israeli digital receipts & compliance
- Document lifecycle: payment → receipt row → Hebrew RTL PDF → Storage → email
- VAT, receipt numbering, pending receipts workflow, go-live readiness gates
- Versioned user consent (terms, privacy, electronic receipts) with signup sync
- Address collection for receipt compliance

### Staff & operations
- Athlete approval workflow, role management, staff search and profile editing
- Activity log with rich metadata and revert actions
- Family accounts (shared billing/history)
- Manager direct messages, birthday auto-messages
- WhatsApp notification rollout (off / testing / live)

## Architecture highlights

- **Backend-as-product:** 166 incremental PostgreSQL migrations with Row Level Security and security-definer RPCs enforce business rules at the database layer.
- **Bilingual RTL:** Full i18n with Hebrew/English, bidi text handling, and RTL-aware PDF generation.
- **Mobile + web parity:** Single Expo codebase serves native (Expo Go / future EAS) and static web PWA with role-based route guards.
- **Async automation:** pg_net + Vault secrets invoke Edge Functions from database triggers (waitlist notify, notification dispatch).
- **Operational undo:** Activity log with revert pattern for manager corrections.

## Scale & codebase

| Metric | Count |
|--------|-------|
| SQL migrations | 166 |
| Edge Functions | 7 |
| Expo Router screens | 58 |
| Screen components | 25 |
| Domain lib modules | 82 |
| UI components | ~95 |
| i18n translation keys | ~2,100+ lines (EN + HE) |

## Deployment

- **Web:** Static Expo export deployed via `render.yaml` (Render Blueprint), Vercel, or Netlify with SPA rewrites.
- **Database:** Supabase migrations via `supabase db push`.
- **Edge Functions:** Deployed with Supabase CLI; secrets for cron auth, Resend, and WhatsApp.
- **Native:** Expo Go for development; EAS Build for future App Store / Play releases.

---

## Resume bullets

Pick 3–5 depending on space. Quantify where possible.

**Full-stack / product**
- Built **Shira Fit**, a bilingual (EN/HE, RTL) fitness-studio operations platform serving athletes, coaches, and managers across mobile and web PWA, replacing manual scheduling and billing workflows.
- Designed and shipped end-to-end session lifecycle (registration, waitlist, attendance, cancellation rules) with **166 PostgreSQL migrations**, Row Level Security, and security-definer RPCs on Supabase.

**Mobile / frontend**
- Developed a **React Native (Expo SDK 55)** app with 58 routes, full Hebrew RTL support, role-based navigation, and static web PWA deployment (Render/Vercel).
- Implemented bilingual i18n, responsive manager dashboards, and web-specific UX (route restore, keyboard/viewport handling) from a single codebase.

**Backend / infrastructure**
- Architected Supabase backend with **7 Edge Functions** (Deno): weekly registration automation, waitlist push, Hebrew RTL PDF generation, email delivery (Resend), and WhatsApp notification dispatch.
- Wired database triggers via **pg_net + Vault** for async Edge Function invocation; configured cron schedules with Asia/Jerusalem timezone handling.

**Domain / compliance**
- Delivered Israeli **digital receipt compliance**: VAT-aware receipt numbering, Hebrew RTL PDF generation, versioned legal consent management, and accountant batch email workflows.
- Built multi-tier pricing engine, coach payout calculations, family accounts, and finance reporting (expected vs collected, penalty tracking).

**UX / operations**
- Shipped manager activity log with **revert actions**, capacity mismatch detection, and WhatsApp rollout controls (off/testing/live) for phased feature deployment.

---

## Interview talking points

1. **Why RPCs over client logic?** Cancellation windows, capacity limits, and billing rules must not be bypassable. RLS + RPCs enforce invariants regardless of client.
2. **RTL PDF generation:** Hebrew receipts require embedded fonts, right-to-left layout, and mixed bidi text — handled in a Deno Edge Function with pdf-lib.
3. **Waitlist automation:** Cancel trigger → pg_net HTTP call → Edge Function → Expo push, with Vault-stored secrets so credentials never live in migration SQL.
4. **Single codebase, three surfaces:** Athletes on phone, coaches on phone during sessions, managers on web PWA — same Expo app, different route trees and role guards.
5. **Incremental migrations:** 166 migrations evolved the schema from MVP (sessions + registration) to full studio ops (finance, receipts, WhatsApp, consent) without downtime rewrites.
