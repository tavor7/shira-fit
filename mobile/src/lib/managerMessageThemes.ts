export const MANAGER_MESSAGE_THEMES = ["love", "happy", "work"] as const;
export type ManagerMessageTheme = (typeof MANAGER_MESSAGE_THEMES)[number];

export type ManagerMessageThemeStyle = {
  glowPrimary: string;
  glowSecondary: string;
  avatarBg: string;
  avatarRing: string;
  cardBorder: string;
  bubbleBg: string;
  bubbleBorder: string;
  bubbleText: string;
  kickerColor: string;
  emoji: string;
};

export function normalizeManagerMessageTheme(raw: unknown): ManagerMessageTheme {
  const v = String(raw ?? "").toLowerCase();
  if (v === "happy" || v === "work") return v;
  return "love";
}

export function getManagerMessageThemeStyle(themeKey: ManagerMessageTheme): ManagerMessageThemeStyle {
  switch (themeKey) {
    case "happy":
      return {
        glowPrimary: "rgba(251, 191, 36, 0.38)",
        glowSecondary: "rgba(249, 115, 22, 0.24)",
        avatarBg: "#f59e0b",
        avatarRing: "rgba(251, 191, 36, 0.35)",
        cardBorder: "rgba(251, 191, 36, 0.35)",
        bubbleBg: "rgba(251, 191, 36, 0.12)",
        bubbleBorder: "rgba(251, 191, 36, 0.28)",
        bubbleText: "#fef3c7",
        kickerColor: "#fcd34d",
        emoji: "☀️",
      };
    case "work":
      return {
        glowPrimary: "rgba(56, 189, 248, 0.32)",
        glowSecondary: "rgba(99, 102, 241, 0.22)",
        avatarBg: "#3b82f6",
        avatarRing: "rgba(96, 165, 250, 0.35)",
        cardBorder: "rgba(96, 165, 250, 0.35)",
        bubbleBg: "rgba(59, 130, 246, 0.12)",
        bubbleBorder: "rgba(96, 165, 250, 0.28)",
        bubbleText: "#dbeafe",
        kickerColor: "#93c5fd",
        emoji: "💼",
      };
    case "love":
    default:
      return {
        glowPrimary: "rgba(244, 63, 94, 0.34)",
        glowSecondary: "rgba(236, 72, 153, 0.24)",
        avatarBg: "#e11d48",
        avatarRing: "rgba(244, 63, 94, 0.35)",
        cardBorder: "rgba(244, 63, 94, 0.35)",
        bubbleBg: "rgba(244, 63, 94, 0.12)",
        bubbleBorder: "rgba(244, 63, 94, 0.28)",
        bubbleText: "#ffe4e6",
        kickerColor: "#fda4af",
        emoji: "💗",
      };
  }
}

export function managerMessageThemeLabelKey(themeKey: ManagerMessageTheme): string {
  return `managerMessage.theme.${themeKey}`;
}
