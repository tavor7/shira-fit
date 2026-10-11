---
name: Shira Fit
description: Fitness studio training app (mobile-first) with a calm, slick dark UI.
colors:
  obsidian-canvas: "#0a0a0b"
  obsidian-chrome: "#121214"
  graphite-surface: "#18181c"
  graphite-surface-elevated: "#222228"
  border: "#2e2e36"
  border-muted: "#25252c"
  border-input: "#3f3f48"
  text: "#f4f4f5"
  text-muted: "#a1a1aa"
  text-soft: "#71717a"
  alert-subject: "#d0d0d8"
  cta: "#f4f4f5"
  cta-text: "#0a0a0b"
  field-paper: "#f0f0f3"
  text-on-light: "#0a0a0b"
  text-muted-on-light: "#52525b"
  text-soft-on-light: "#71717a"
  placeholder-on-light: "#a1a1aa"
  success: "#22c55e"
  success-bg: "#142818"
  error: "#ef4444"
  error-bg: "#2a1515"
  error-border: "#7f1d1d"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "0.2px"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.2px"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.2px"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0.15px"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.3px"
rounded:
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "28px"
  full: "9999px"
spacing:
  xs: "6px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.cta}"
    textColor: "{colors.cta-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "15px 20px"
  button-secondary:
    backgroundColor: "{colors.graphite-surface-elevated}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "15px 20px"
  chip:
    backgroundColor: "{colors.graphite-surface}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "3px 8px"
---

# Design System: Shira Fit

## 1. Overview

**Creative North Star: "The Carbon Club"**

This interface should feel like a well-run studio at peak hour: calm, disciplined, and fast. The UI is deliberately dark, with tonal layering instead of heavy decoration, so athletes can scan quickly and staff can act without friction.

The personality is modern, slick, and simple, without corporate stiffness. Density is controlled through spacing and hierarchy, not through endless cards.

**Key Characteristics:**
- **Tonal dark layers** (canvas → chrome → surfaces) with crisp borders for structure
- **High-contrast type** with clear hierarchy, tuned for quick scanning on phones
- **One “crisp CTA”** approach (light filled primary action on dark)
- **Touch-first ergonomics**: big hit targets, pill controls, predictable spacing
- **RTL-first correctness**: layouts and icons must mirror cleanly

## 2. Colors

The palette is restrained and intentional: near-black neutrals carry most of the surface, while the light CTA is used as the “one crisp action” signal.

### Primary
- **Crisp CTA** (`{colors.cta}`): primary action fills (buttons, confirmations). Used sparingly to keep it meaningful.

### Neutral
- **Obsidian Canvas** (`{colors.obsidian-canvas}`): app background, deepest layer.
- **Obsidian Chrome** (`{colors.obsidian-chrome}`): headers, nav chrome, secondary regions.
- **Graphite Surface** (`{colors.graphite-surface}`): cards, hero blocks, list rows.
- **Graphite Elevated Surface** (`{colors.graphite-surface-elevated}`): sheets/popovers, subtle emphasis.
- **Borders** (`{colors.border}`, `{colors.border-muted}`, `{colors.border-input}`): structure and input affordances.
- **Text** (`{colors.text}`), **Muted** (`{colors.text-muted}`), **Soft** (`{colors.text-soft}`): readable hierarchy without haze.

### Named Rules
**The One Crisp Action Rule.** On any screen, treat `{colors.cta}` as the primary action signal. If everything is a CTA, nothing is.

**The No-Flash Rule.** Avoid neon accents and flashy colors. Meaning comes from contrast, hierarchy, and tone, not chroma.

## 3. Typography

**Display/Body Font:** system UI (iOS San Francisco / Android Roboto / web system-ui).

**Character:** clean and efficient. Weight carries hierarchy more than font changes. Copy stays short and confident.

### Hierarchy
- **Display** (800, 22px, \(lh\) 1.15): screen titles and entry headers.
- **Headline** (800, 18px, \(lh\) 1.2): section titles and primary grouping.
- **Title** (700, 16px, \(lh\) 1.25): strong row labels, key values.
- **Body** (500, 16px, \(lh\) 1.45): default content and button text.
- **Label** (700, 12px, \(lh\) 1.2, wider tracking): field labels and compact metadata.

Supporting roles (all in `theme.typography`, used through `AppText variant`):
- **Secondary** (500, 14px): supporting body text, empty/error state bodies.
- **Caption** (600, 13px): metadata (dates, counts, small status lines).
- **Helper** (500, 13px): field help and validation messages.
- **Button** (600, 16px) / **Button compact** (600, 14px).
- **Tab** (700, 13px): tabs, segments and chips.

Screen titles use Display inside the content (the header carries identity and navigation, not titles).

### Named Rules
**The Readable-by-Default Rule.** Text should remain readable without zooming. Favor clear contrast and minimum 16px body on mobile.

## 4. Elevation

Depth is primarily communicated through tonal layering and borders. Shadows exist, but they are not decorative; they appear mainly for modals/sheets and key pressable elements where the user needs a strong affordance.

### Named Rules
**The Tonal-First Rule.** Prefer surface steps + borders over bigger shadows. If a shadow reads “glam”, it’s wrong.

## 5. Components

### Controls and touch targets
- Every interactive control is at least **44×44px** to touch (`theme.controls.minTouch`). Compact visuals (icon buttons, switches, row actions) reach it with an invisible padding ring offset by equal negative margins, which also works on the web (react-native-web ignores `hitSlop`).
- Icon-only controls use `IconButton` and must have an accessible name.
- Selection controls expose their state with `selectionA11y(kind, selected)`: `tab` (aria-selected), `radio` for single choices (aria-checked, inside a radiogroup), `checkbox` for independent or multi-select choices, `toggle` (aria-pressed). Few-option single choices use `SegmentedChoice`.
- Long tab rows scroll horizontally on one line; an edge fade (`EdgeFade`) marks the side where more continues.

### Icons
- One family: Ionicons through `AppIcon` (outline style; sizes 16 / 20 / 24 / 40). No emoji as interface icons; emoji stay only in content people write (message themes, birthday messages).

### Buttons
- **Primary (light filled)**: `{colors.cta}` background, `{colors.cta-text}` text, rounded `{rounded.md}` (14px), padding (15px 20px), min height (52px).
- **Secondary (ghost filled)**: `{colors.graphite-surface-elevated}` background with `{colors.border}` stroke. The compact size (44px, `ActionButton` / `size="compact"`) is used for secondary actions in dense panels.
- **Destructive**: `variant="danger"` (error tint). A destructive confirmation is never styled as the primary action, and its dismiss button names the safe outcome ("Keep my spot", not "Cancel").
- **Press feedback**: slight opacity change and subtle scale-down only when it improves clarity; honor reduced motion.

### Chips
- **Shape**: fully rounded (`{rounded.full}`).
- **Type**: uppercase label feel, tighter height (3px vertical padding).
- **Tone**: use translucent tints for success/warning/danger/info while keeping text readable.

### Cards / Sheets
- **Card**: `{colors.graphite-surface}` with `{colors.border-muted}` border, rounded `{rounded.md}`.
- **Sheet**: elevated surface with larger top radius (`{rounded.xl}`) and strong border separation.

### States
- **Loading** (skeletons for lists, `LoadingState` for one-off transitions), **empty** (only after a successful load), **error** (`ErrorState` with a retry) and **not found** are distinct; an empty message is never shown while loading or after a failure.
- Users never see raw technical errors: messages go through `lib/userFacingError` (toasts and alerts apply it automatically). Business-rule messages written for people are kept.

### Inputs / Fields
- Prefer readable “paper” fields on dark when necessary (`{colors.field-paper}`) with dark text (`{colors.text-on-light}`), rather than low-contrast dark inputs.
- Focus state should be obvious without neon: `AppTextField` shows a 2px light border on focus. Validation and help text sit under the field (`errorText` / `helperText`).
- In Hebrew, fields are right-aligned but the text direction follows the content, so English values (emails, addresses) are not clipped at their beginning.

## 6. Do's and Don'ts

### Do:
- **Do** keep screens calm and uncluttered: progressive disclosure beats dense dashboards.
- **Do** keep touch targets large (pills, buttons, row taps) and spacing consistent with the spacing scale.
- **Do** design RTL intentionally (mirrored icons, correct `start/end` spacing, no “hardcoded left” assumptions).
- **Do** support reduced motion (state transitions only; avoid motion-only meaning).
- **Do** maintain high contrast and readable typography (aim WCAG AA).

### Don't:
- **Don't** let the UI become cluttered or overly “corporate”.
- **Don't** use childish or gaming-style UI tropes.
- **Don't** use excessive animations or flashy colors.
- **Don't** use colored side-stripe borders as accents (border-left/right > 1px). Exception: a stripe that encodes meaning (coach colour, alert kind, severity, paid) — always `theme.accentStripeWidth` (3px) on the logical start edge, so it mirrors in Hebrew.
- **Don't** use gradient text or glassmorphism as a default style.

