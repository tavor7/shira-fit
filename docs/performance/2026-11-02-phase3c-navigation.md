# Phase 3C — Navigation: reuse open sections, consistent Back / Forward (2026-11-02)

Branch `perf/nav-sections` (from `main` 52d3001). **Not deployed; needs your approval.** All results [M-local]: isolated
perf stack, Playwright Chromium and WebKit (Safari's engine) at iPhone size. Real iPhone / Android not tested.

## Root cause of the Safari behaviour

Every open dialog (including the ≡ menu) adds a browser-history entry so browser Back closes the dialog
(`webBackDismiss`). When a dialog action navigates, `webBackDismiss` removes that entry before the router's
**push / replace** — but it did not handle the router's **back traversals** (`history.go(-n)` / `back()`), which the
router uses when it closes screens. Returning to an open section from the menu therefore produced, within 5 ms:

```
router:  history.go(-2)      (close the two screens above Sessions)
menu:    history.back()      (remove the menu's own entry)
```

Two overlapping history traversals. **Chromium** applied both (3 steps: the next Back left the app via a blank page);
**WebKit** let the second cancel the first (history no longer matched the screens, so Back walked earlier sections).
The same latent bug affected any dialog action that closes screens.

## Corrected design

1. **Sections are reused** (`menuNavigation.ts`): a staff menu destination that is already open is returned to
   (`router.dismissTo`); one that is not open is pushed exactly as before. Athlete sections are tabs (unchanged).
2. **Traversals are sequenced** (`webBackDismiss.ts`): `history.go(-n)` / `history.back()` are handled like push /
   replace — the dialog entry is removed silently first, then the router's traversal runs. No Back is swallowed, history
   is not disabled, there is no browser-specific branch.
3. **Header back pill** "back to section" (Overview → "Back to sessions calendar", Setup …) returns to the section when it
   is already open instead of building a second copy with `router.replace` (found by the suite: it left two homes).

## Browser compatibility and Back / Forward — `harness/nav-suite.mjs`

| Journey | Today (main), Chromium = WebKit | New, **Chromium = WebKit** |
|---|---|---|
| N1 12 menu taps (manager): mounted screens | 2 → 13 | cycles 1-4 |
| N2 after returning to Sessions: Back / Forward | Back retraces every earlier menu tap | Back leaves the app (Sessions is the first app entry, as on a fresh home); Forward returns to Sessions |
| N3 unsaved Create Session form + menu → Sessions | no prompt; form stays hidden underneath (Back returns to it) | **"Leave without saving?"** — Cancel keeps the edit; Discard → Sessions, 1 screen |
| N4 deep link (cold open of a subscription) → menu Sessions → Back | Sessions pushed; Back → the subscription | same |
| N5 coach: 6 menu taps | 2 → 7 screens | cycles 1-2 |
| N6 menu open → browser Back | menu closes, page stays; next Back → previous screen | same |
| N7 Overview → header "Back to sessions calendar" | Sessions, **2 screens** (duplicate home) | Sessions, **1 screen** |
| N8 reload on a section | restored | restored |

The prototype before the fix (for reference): Chromium N2 Back → blank page on the second Back; WebKit N2 Back →
Overview, Sessions. After the fix both engines give identical results on every journey (N1-N8).

## Performance and memory (Chromium, 12 menu taps)

| Metric | Today | New |
|---|---|---|
| Mounted screens | 13 | ≤ 4 |
| JS heap | 89 MB | **31 MB** |
| DOM nodes | 15,803 | **2,505** |
| Requests per realtime event (hidden homes) | 20 | 17 |
| Menu → Sessions, tap → content | 934 ms | **453 ms (−51%)** |
| Other menu / tab / back steps | — | within noise |

## Functional regression

- compare-ui (all visible text and accessibility labels): home 12 + Session Detail 8 scenarios — **20/20 identical in
  Chromium and 20/20 in WebKit**.
- Jest 837 passed (menuNavigation 6 tests), tsc clean, lint 0 errors.
- Athlete navigation unchanged (tabs); role routing and deep links unaffected (the helper acts only when the destination
  is already open).

## Remaining risks

- Real devices: iPhone Home Screen PWA and Android not tested (Playwright WebKit is the engine, not the device).
- Behaviour change you approved: Back after returning to an open section no longer retraces earlier menu taps.
- `webBackDismiss` change affects every dialog; covered by N3 / N6 and the existing dialog flows exercised by the
  suites, but dialogs that close screens from inside (rare) should get a manual pass on device.
- Commit cb91e72's message still says "PROTOTYPE (needs UX approval)" (kept for history; the UX was approved since).
