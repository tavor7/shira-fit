# Phase 4 — Loading only the active language: investigated, not recommended

- Translations: 2,175 keys in each of Hebrew and English, none missing either way; 431 KB of the 4.3 MB bundle.
- Upper bound measured with a throw-away build that removed English completely [M-local]:
  - download: −135 KB raw, **−21 KB brotli (−2.8%)**, once per release (assets are cached `immutable` between releases);
  - startup, Chromium with 4× CPU throttling, 15 interleaved runs each: script time median 0.172 s (both languages) vs
    0.205 s (English removed), minimum 0.157 vs 0.156 s; login visible median 403 vs 448 ms — **no measurable gain**.
- Cost of the real change: language chunks loaded asynchronously, a wait (or prefetch) on switching, risk of a flash of
  untranslated text, and offline failure when switching to a never-loaded language in the installed app.
- Recommendation: do not implement. No code was changed. Revisit only if real-iPhone traces show script time dominating
  cold start.
