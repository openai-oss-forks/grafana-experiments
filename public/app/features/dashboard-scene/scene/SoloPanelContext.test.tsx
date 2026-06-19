import { act, render } from '@testing-library/react';

import { SceneComponentProps, VizPanel } from '@grafana/scenes';

import { SoloPanelContext, SoloPanelContextWithPathIdFilter } from './SoloPanelContext';
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

describe('SoloPanelContext', () => {
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
});
