import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type { CreateTaskInput, ID } from '@/types';

/** Prefill applied when the task composer is opened from a contextual action. */
export type TaskDrawerPrefill = Partial<CreateTaskInput>;

interface UIContextValue {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  taskDrawerOpen: boolean;
  taskDrawerPrefill: TaskDrawerPrefill;
  openTaskDrawer: (prefill?: TaskDrawerPrefill) => void;
  closeTaskDrawer: () => void;

  /** Task detail opened as a side panel from a board or list. */
  taskPanelId: ID | null;
  openTaskPanel: (id: ID) => void;
  closeTaskPanel: () => void;
}

const UIContext = createContext<UIContextValue | null>(null);

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsedState] = useLocalStorage(
    'epm.sidebar.collapsed',
    false,
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [taskDrawerPrefill, setTaskDrawerPrefill] = useState<TaskDrawerPrefill>({});
  const [taskPanelId, setTaskPanelId] = useState<ID | null>(null);

  const openTaskDrawer = useCallback(
    (prefill: TaskDrawerPrefill = {}) => {
      setTaskDrawerPrefill(prefill);
      setTaskDrawerOpen(true);
    },
    [],
  );

  const value = useMemo<UIContextValue>(
    () => ({
      sidebarCollapsed,
      toggleSidebar: () => setSidebarCollapsedState((current) => !current),
      setSidebarCollapsed: (collapsed: boolean) => setSidebarCollapsedState(collapsed),
      mobileNavOpen,
      setMobileNavOpen,
      commandPaletteOpen,
      setCommandPaletteOpen,
      taskDrawerOpen,
      taskDrawerPrefill,
      openTaskDrawer,
      closeTaskDrawer: () => setTaskDrawerOpen(false),
      taskPanelId,
      openTaskPanel: setTaskPanelId,
      closeTaskPanel: () => setTaskPanelId(null),
    }),
    [
      sidebarCollapsed,
      setSidebarCollapsedState,
      mobileNavOpen,
      commandPaletteOpen,
      taskDrawerOpen,
      taskDrawerPrefill,
      openTaskDrawer,
      taskPanelId,
    ],
  );

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI(): UIContextValue {
  const context = useContext(UIContext);
  if (!context) throw new Error('useUI must be used inside a UIProvider');
  return context;
}
