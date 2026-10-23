import { useCallback, useRef, useState } from "react";
import type { Tab } from "../../types";

export function useWorkspaceTabs() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeID, setActiveID] = useState("");
  const tabsRef = useRef(tabs);
  const activeIDRef = useRef(activeID);
  tabsRef.current = tabs;
  activeIDRef.current = activeID;

  const update = useCallback((tabID: string, fn: (tab: Tab) => Tab) => {
    setTabs(current => current.map(tab => tab.id === tabID ? fn(tab) : tab));
  }, []);

  return { tabs, setTabs, tabsRef, activeID, setActiveID, activeIDRef, update };
}
