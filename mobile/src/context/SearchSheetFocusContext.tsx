import { createContext, useContext } from "react";

export type SearchSheetFocusContextValue = {
  /** True while the software keyboard is open (sheet uses compact layout). */
  isCompact: boolean;
};

export const SearchSheetFocusContext = createContext<SearchSheetFocusContextValue | null>(null);

export function useSearchSheetFocus(): SearchSheetFocusContextValue | null {
  return useContext(SearchSheetFocusContext);
}
