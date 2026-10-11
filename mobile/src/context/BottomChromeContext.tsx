import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomChromeState } from "../lib/screenLayout";

/**
 * Tracks what occupies the bottom of the viewport (see lib/screenLayout.ts): the contact footer and
 * in-screen bottom bars report their measured heights here, so the floating accessibility button,
 * toasts and scrollable content can stay clear of them, and only the bottom-most element applies
 * the device safe-area inset.
 */
type Ctx = {
  state: BottomChromeState;
  setFooterHeight: (h: number) => void;
  setBarHeight: (id: string, h: number | null) => void;
};

const BottomChromeCtx = createContext<Ctx | null>(null);

export function BottomChromeProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [footerHeight, setFooterHeightState] = useState(0);
  const [bars, setBars] = useState<Record<string, number>>({});

  const setFooterHeight = useCallback((h: number) => {
    setFooterHeightState((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
  }, []);
  const setBarHeight = useCallback((id: string, h: number | null) => {
    setBars((prev) => {
      if (h == null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return prev[id] !== undefined && Math.abs(prev[id] - h) < 0.5 ? prev : { ...prev, [id]: h };
    });
  }, []);

  const state = useMemo<BottomChromeState>(
    () => ({
      footerHeight,
      barsHeight: Object.values(bars).reduce((a, b) => a + b, 0),
      safeAreaBottom: insets.bottom,
      fabVisible: Platform.OS === "web",
    }),
    [footerHeight, bars, insets.bottom]
  );

  const value = useMemo(() => ({ state, setFooterHeight, setBarHeight }), [state, setFooterHeight, setBarHeight]);
  return <BottomChromeCtx.Provider value={value}>{children}</BottomChromeCtx.Provider>;
}

const FALLBACK: Ctx = {
  state: { footerHeight: 0, barsHeight: 0, safeAreaBottom: 0, fabVisible: Platform.OS === "web" },
  setFooterHeight: () => undefined,
  setBarHeight: () => undefined,
};

export function useBottomChrome(): BottomChromeState {
  return (useContext(BottomChromeCtx) ?? FALLBACK).state;
}

/** onLayout handler for the contact footer; resets to 0 when the footer unmounts. */
export function useReportFooterHeight(): (e: LayoutChangeEvent) => void {
  const { setFooterHeight } = useContext(BottomChromeCtx) ?? FALLBACK;
  useEffect(() => () => setFooterHeight(0), [setFooterHeight]);
  return useCallback((e: LayoutChangeEvent) => setFooterHeight(e.nativeEvent.layout.height), [setFooterHeight]);
}

let barSeq = 0;

/**
 * onLayout handler for an in-screen bottom bar (laid out below the screen's scroll area).
 * Pass `active: false` while the bar is not rendered; it unregisters on unmount.
 */
export function useReportBottomBar(active = true): (e: LayoutChangeEvent) => void {
  const { setBarHeight } = useContext(BottomChromeCtx) ?? FALLBACK;
  const idRef = useRef<string | null>(null);
  if (idRef.current == null) idRef.current = `bar-${++barSeq}`;
  useEffect(() => {
    const id = idRef.current as string;
    if (!active) setBarHeight(id, null);
    return () => setBarHeight(id, null);
  }, [active, setBarHeight]);
  return useCallback(
    (e: LayoutChangeEvent) => {
      if (active) setBarHeight(idRef.current as string, e.nativeEvent.layout.height);
    },
    [active, setBarHeight]
  );
}
