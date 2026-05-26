import { createContext, useContext } from "react";

export type SearchSheetFocusContextValue = {
  /** Search field received focus — sheet should use compact keyboard layout. */
  registerFocus: () => void;
  registerBlur: () => void;
  /** True while the keyboard is open or the search field is focused. */
  isCompact: boolean;
};

export const SearchSheetFocusContext = createContext<SearchSheetFocusContextValue | null>(null);

export function useSearchSheetFocus(): SearchSheetFocusContextValue | null {
  return useContext(SearchSheetFocusContext);
}
