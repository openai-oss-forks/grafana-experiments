import { act, render } from '@testing-library/react';
import { Suspense } from 'react';

import { SceneComponentProps, VizPanel } from '@grafana/scenes';

import {
  SoloPanelContext,
  SoloPanelContextValue,
  SoloPanelContextWithPathIdFilter,
  useRegisterSoloPanelMatch,
} from './SoloPanelContext';
import { DashboardGridItem } from './layout-default/DashboardGridItem';
import { DashboardGridItemRenderer } from './layout-default/DashboardGridItemRenderer';

jest.mock('../utils/utils', () => ({
  ...jest.requireActual('../utils/utils'),
  useDashboardState: () => ({ preload: false }),
}));

class TestVizPanel extends VizPanel {
  public static Component = ({ model }: SceneComponentProps<VizPanel>) => (
    <div data-testid={model.state.key}>{model.state.key}</div>
  );
}

const neverResolves = new Promise<void>(() => {});

function MatchRegistration({
  context,
  scope,
  matchFound,
  suspend = false,
}: {
  context: SoloPanelContextValue;
  scope: object;
  matchFound: boolean;
  suspend?: boolean;
}) {
  useRegisterSoloPanelMatch(context, scope, matchFound);
  if (suspend) {
    throw neverResolves;
  }
  return null;
}

describe('SoloPanelContext', () => {
  it('can reset a match when the repeated panel set changes', () => {
    const context = new SoloPanelContextWithPathIdFilter('panel-1-clone-1');
    const matchingPanel = {
      state: { key: 'panel-1-clone-1' },
      getPathId: () => 'panel-1-clone-1',
    } as unknown as VizPanel;
    const replacementPanel = {
      state: { key: 'panel-1-clone-2' },
      getPathId: () => 'panel-1-clone-2',
    } as unknown as VizPanel;
    const scope = {};

    context.recordMatch(scope, context.matches(matchingPanel));
    expect(context.matchFound).toBe(true);

    context.recordMatch(scope, context.matches(replacementPanel));

    expect(context.matchFound).toBe(false);
  });

  it('updates a mounted grid item match when its repeated panels change', () => {
    const sourcePanel = new TestVizPanel({ key: 'panel-1', pluginId: 'timeseries' });
    const matchingRepeat = new TestVizPanel({ key: 'panel-2', pluginId: 'timeseries' });
    const replacementRepeat = new TestVizPanel({ key: 'panel-3', pluginId: 'timeseries' });
    jest.spyOn(sourcePanel, 'activate').mockReturnValue(jest.fn());
    jest.spyOn(matchingRepeat, 'activate').mockReturnValue(jest.fn());
    jest.spyOn(replacementRepeat, 'activate').mockReturnValue(jest.fn());
    const gridItem = new DashboardGridItem({
      body: sourcePanel,
      repeatedPanels: [matchingRepeat],
      variableName: 'server',
    });
    const context = new SoloPanelContextWithPathIdFilter('2');

    render(
      <SoloPanelContext.Provider value={context}>
        <DashboardGridItemRenderer model={gridItem} />
      </SoloPanelContext.Provider>
    );

    expect(context.matchFound).toBe(true);

    act(() => gridItem.setState({ repeatedPanels: [replacementRepeat] }));

    expect(context.matchFound).toBe(false);
  });

  it('only records match updates that React commits', () => {
    const context = new SoloPanelContextWithPathIdFilter('2');
    const uncommittedScope = {};
    const { unmount } = render(
      <Suspense fallback={null}>
        <MatchRegistration context={context} scope={uncommittedScope} matchFound={true} suspend={true} />
      </Suspense>
    );

    expect(context.matchFound).toBe(false);
    unmount();
    expect(context.matchFound).toBe(false);
  });
});
