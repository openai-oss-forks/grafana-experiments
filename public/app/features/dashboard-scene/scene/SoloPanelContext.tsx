import React, { useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';

import { Trans } from '@grafana/i18n';
import { LazyLoader, VizPanel } from '@grafana/scenes';
import { Box, Spinner } from '@grafana/ui';

import { DashboardScene } from './DashboardScene';

export interface SoloPanelContextValue {
  matches: (VizPanel: VizPanel) => boolean;
  readonly matchFound: boolean;
  recordMatch: (scope: object, matchFound: boolean) => void;
  clearMatch: (scope: object) => void;
  subscribeToMatch: (listener: () => void) => () => void;
}

export abstract class SoloPanelContextValueBase implements SoloPanelContextValue {
  private matchingScopes = new Set<object>();
  private matchListeners = new Set<() => void>();

  public get matchFound() {
    return this.matchingScopes.size > 0;
  }

  public recordMatch(scope: object, matchFound: boolean) {
    const previousMatchFound = this.matchFound;
    if (matchFound) {
      this.matchingScopes.add(scope);
    } else {
      this.matchingScopes.delete(scope);
    }
    this.notifyMatchChanged(previousMatchFound);
  }

  public clearMatch(scope: object) {
    const previousMatchFound = this.matchFound;
    this.matchingScopes.delete(scope);
    this.notifyMatchChanged(previousMatchFound);
  }

  public subscribeToMatch = (listener: () => void) => {
    this.matchListeners.add(listener);
    return () => this.matchListeners.delete(listener);
  };

  public abstract matches(panel: VizPanel): boolean;

  private notifyMatchChanged(previousMatchFound: boolean) {
    if (previousMatchFound !== this.matchFound) {
      this.matchListeners.forEach((listener) => listener());
    }
  }
}

export class SoloPanelContextWithPathIdFilter extends SoloPanelContextValueBase {
  public constructor(public keyPath: string) {
    super();
  }

  public matches(panel: VizPanel): boolean {
    // Check if keyPath is just an old legacy panel id
    if (/^\d+$/.test(this.keyPath)) {
      return `panel-${this.keyPath}` === panel.state.key!;
    }

    return this.keyPath === panel.getPathId();
  }
}

export const SoloPanelContext = React.createContext<SoloPanelContextValue | null>(null);

export function useDefineSoloPanelContext(keyPath?: string): SoloPanelContextValue | null {
  return React.useMemo(() => {
    if (!keyPath) {
      return null;
    }
    return new SoloPanelContextWithPathIdFilter(keyPath);
  }, [keyPath]);
}

export function useSoloPanelContext() {
  return useContext(SoloPanelContext);
}

export function renderMatchingSoloPanels(
  soloPanelContext: SoloPanelContextValue,
  panels: VizPanel[],
  isLazy?: boolean
): { content: React.ReactNode; matchFound: boolean } {
  const matches: React.ReactNode[] = [];
  for (const panel of panels) {
    if (soloPanelContext.matches(panel)) {
      if (isLazy) {
        matches.push(
          <LazyLoader key={panel.state.key!}>
            <panel.Component model={panel} />
          </LazyLoader>
        );
      } else {
        matches.push(<panel.Component model={panel} key={panel.state.key} />);
      }
    }
  }

  return { content: <>{matches}</>, matchFound: matches.length > 0 };
}

export function useRegisterSoloPanelMatch(
  soloPanelContext: SoloPanelContextValue | null,
  scope: object,
  matchFound: boolean
) {
  useLayoutEffect(() => {
    if (!soloPanelContext) {
      return;
    }

    soloPanelContext.recordMatch(scope, matchFound);
    return () => soloPanelContext.clearMatch(scope);
  }, [matchFound, scope, soloPanelContext]);
}

export function SoloPanelContextProvider({
  children,
  value,
  singleMatch,
  dashboard,
}: {
  children: React.ReactNode;
  value: SoloPanelContextValue;
  singleMatch: boolean;
  dashboard: DashboardScene;
}) {
  return (
    <SoloPanelContext.Provider value={value}>
      {children}
      <SoloPanelNotFound singleMatch={singleMatch} dashboard={dashboard} />
    </SoloPanelContext.Provider>
  );
}

export interface SoloPanelNotFoundProps {
  /**
   * Controls panel not found error message
   */
  singleMatch: boolean;
  /**
   * Used to check if variables are loading
   */
  dashboard: DashboardScene;
}

export function SoloPanelNotFound({ singleMatch, dashboard }: SoloPanelNotFoundProps) {
  const context = useSoloPanelContext()!;
  const matchFound = useSyncExternalStore(
    context.subscribeToMatch,
    () => context.matchFound,
    () => false
  );
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Repeated panels can appear after variable loading completes, so keep the not-found state pending until then.
    setIsLoading(true);
    const cancelTimeout = setInterval(() => {
      setIsLoading(isAnyVariableLoading(dashboard));
    }, 500);

    return () => clearInterval(cancelTimeout);
  }, [context, dashboard]);

  if (matchFound) {
    return null;
  }

  if (isLoading) {
    return <Spinner />;
  }

  return (
    <Box
      backgroundColor={'primary'}
      borderColor={'weak'}
      borderStyle={'solid'}
      padding={2}
      borderRadius={'default'}
      display={'flex'}
      justifyContent={'center'}
      alignItems={'center'}
    >
      {singleMatch && <Trans i18nKey="dashboard.view-panel.not-found">Panel not found</Trans>}
      {!singleMatch && <Trans i18nKey="dashboard.search-panel.no-match">No panels matching</Trans>}
    </Box>
  );
}

function isAnyVariableLoading(scene: DashboardScene) {
  const variables = scene.state.$variables;
  if (!variables || !variables.isActive) {
    return true;
  }

  return variables.state.variables.some((variable) => variable.state.loading);
}
