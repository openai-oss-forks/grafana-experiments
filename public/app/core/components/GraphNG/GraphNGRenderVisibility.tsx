import { createContext, ReactNode, useContext } from 'react';

const GraphNGRenderVisibilityContext = createContext(true);

interface GraphNGRenderVisibilityProviderProps {
  children: ReactNode;
  active: boolean;
}

export function GraphNGRenderVisibilityProvider({ children, active }: GraphNGRenderVisibilityProviderProps) {
  return <GraphNGRenderVisibilityContext.Provider value={active}>{children}</GraphNGRenderVisibilityContext.Provider>;
}

export function useGraphNGRenderVisibility(): boolean {
  return useContext(GraphNGRenderVisibilityContext);
}

interface GraphNGRendererGateProps {
  children: ReactNode;
  suspendWhenInactive: boolean;
}

export function GraphNGRendererGate({ children, suspendWhenInactive }: GraphNGRendererGateProps) {
  const active = useGraphNGRenderVisibility();
  return suspendWhenInactive && !active ? null : children;
}
