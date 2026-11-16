import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface PackagesMenuContextType {
  visible: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const PackagesMenuContext = createContext<PackagesMenuContextType | null>(null);

export function PackagesMenuProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const toggle = useCallback(() => setVisible((v) => !v), []);

  return (
    <PackagesMenuContext.Provider value={{ visible, open, close, toggle }}>
      {children}
    </PackagesMenuContext.Provider>
  );
}

export function usePackagesMenu() {
  const ctx = useContext(PackagesMenuContext);
  if (!ctx) throw new Error("usePackagesMenu must be used within PackagesMenuProvider");
  return ctx;
}
