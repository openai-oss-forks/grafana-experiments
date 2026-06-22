import { PanelPlugin } from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { VizPanel } from '@grafana/scenes';
import { OptionFilter } from 'app/features/dashboard/components/PanelEditor/OptionsPaneOptions';
import { getDashboardSrv } from 'app/features/dashboard/services/DashboardSrv';

import { transformSaveModelToScene } from '../serialization/transformSaveModelToScene';
import { DashboardModelCompatibilityWrapper } from '../utils/DashboardModelCompatibilityWrapper';
import { findVizPanelByKey } from '../utils/utils';

import { PanelOptionsPane } from './PanelOptionsPane';
import { testDashboard } from './testfiles/testDashboard';

let pluginToLoad: PanelPlugin | undefined;
let mockImportPanelPlugin: (id: string) => Promise<PanelPlugin>;

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getPluginImportUtils: () => ({
    getPanelPluginFromCache: jest.fn(() => pluginToLoad),
    importPanelPlugin: jest.fn((id: string) => mockImportPanelPlugin(id)),
  }),
}));

describe('PanelOptionsPane', () => {
  beforeEach(() => {
    pluginToLoad = undefined;
    mockImportPanelPlugin = (id) => Promise.resolve(pluginToLoad ?? getPanelPlugin({ id }));
  });

  describe('When changing plugin', () => {
    it('keeps cached options isolated between the edited panel and its preview', async () => {
      const { optionsPane, panel } = setupTest('panel-1');
      const realPanelChange = jest.fn(
        async (pluginId: string, options = {}, fieldConfig = { defaults: {}, overrides: [] }) => {
          panel.setState({ pluginId, options, fieldConfig });
        }
      );
      panel.changePluginType = realPanelChange;
      panel.setState({ options: { legend: { showLegend: false } } });
      const preview = new VizPanel({
        pluginId: 'timeseries',
        options: { legend: { showLegend: true } },
      });
      preview.changePluginType = jest.fn(
        async (pluginId: string, options = {}, fieldConfig = { defaults: {}, overrides: [] }) => {
          preview.setState({ pluginId, options, fieldConfig });
        }
      );

      expect(panel.state.pluginId).toBe('timeseries');

      await optionsPane.onChangePanel({ pluginId: 'table', withModKey: true });
      await optionsPane.onChangePanel({ pluginId: 'barchart', withModKey: true }, preview);
      await optionsPane.onChangePanel({ pluginId: 'timeseries', withModKey: true });

      expect(realPanelChange).toHaveBeenLastCalledWith(
        'timeseries',
        { legend: { showLegend: false } },
        expect.any(Object)
      );
    });

    it('uses panel configuration changed while the next plugin is preloading', async () => {
      const { optionsPane, panel } = setupTest('panel-1');
      let finishPreload!: () => void;
      mockImportPanelPlugin = (id) =>
        new Promise((resolve) => {
          finishPreload = () => resolve(getPanelPlugin({ id }));
        });
      panel.changePluginType = jest.fn(async (pluginId, options = {}, fieldConfig) => {
        panel.setState({ pluginId, options, fieldConfig });
      });

      const change = optionsPane.onChangePanel({ pluginId: 'table', withModKey: true });
      panel.setState({
        options: { legend: { showLegend: false } },
        fieldConfig: {
          ...panel.state.fieldConfig,
          defaults: { ...panel.state.fieldConfig.defaults, unit: 'ms' },
        },
      });
      finishPreload();
      await change;

      expect(panel.changePluginType).toHaveBeenCalledWith(
        'table',
        undefined,
        expect.objectContaining({ defaults: expect.objectContaining({ unit: 'ms' }) })
      );

      mockImportPanelPlugin = (id) => Promise.resolve(getPanelPlugin({ id }));
      await optionsPane.onChangePanel({ pluginId: 'timeseries', withModKey: true });
      expect(panel.changePluginType).toHaveBeenLastCalledWith(
        'timeseries',
        { legend: { showLegend: false } },
        expect.any(Object)
      );
    });

    it('When visualization suggestion is selected should update options and fieldConfig', async () => {
      pluginToLoad = getPanelPlugin({
        id: 'timeseries',
      });

      pluginToLoad.useFieldConfig({
        useCustomConfig: (builder) => {
          builder.addBooleanSwitch({
            name: 'axisBorderShow',
            path: 'axisBorderShow',
            defaultValue: false,
          });
        },
      });

      const { optionsPane, panel } = setupTest('panel-1');
      panel.setState({ $data: undefined });
      panel.activate();

      await optionsPane.onChangePanel({
        pluginId: 'table',
        options: { showHeader: false },
        fieldConfig: {
          defaults: { custom: { axisBorderShow: true } },
          overrides: [],
        },
      });

      expect(panel.state.options).toEqual({ showHeader: false });
      expect((panel.state.fieldConfig.defaults.custom as any).axisBorderShow).toEqual(true);
    });

    it('Should preserve correct field config', async () => {
      const { optionsPane, panel } = setupTest('panel-1');

      const mockFn = jest.fn();
      panel.changePluginType = mockFn;

      const fieldConfig = panel.state.fieldConfig;

      fieldConfig.defaults = {
        ...fieldConfig.defaults,
        unit: 'flop',
        decimals: 2,
      };

      fieldConfig.overrides = [
        {
          matcher: {
            id: 'byName',
            options: 'A-series',
          },
          properties: [
            {
              id: 'displayName',
              value: 'test',
            },
          ],
        },
        {
          matcher: { id: 'byName', options: 'D-series' },
          //should be removed because it's custom
          properties: [
            {
              id: 'custom.customPropNoExist',
              value: 'google',
            },
          ],
        },
      ];

      panel.setState({ fieldConfig: fieldConfig });

      expect(panel.state.fieldConfig.defaults.color?.mode).toBe('palette-classic');
      expect(panel.state.fieldConfig.defaults.thresholds?.mode).toBe('absolute');
      expect(panel.state.fieldConfig.defaults.unit).toBe('flop');
      expect(panel.state.fieldConfig.defaults.decimals).toBe(2);
      expect(panel.state.fieldConfig.overrides).toHaveLength(2);
      expect(panel.state.fieldConfig.overrides[1].properties).toHaveLength(1);
      expect(panel.state.fieldConfig.defaults.custom).toHaveProperty('axisBorderShow');

      await optionsPane.onChangePanel({ pluginId: 'table' });

      expect(mockFn).toHaveBeenCalled();
      expect(mockFn.mock.calls[0][2].defaults.color?.mode).toBe('palette-classic');
      expect(mockFn.mock.calls[0][2].defaults.thresholds?.mode).toBe('absolute');
      expect(mockFn.mock.calls[0][2].defaults.unit).toBe('flop');
      expect(mockFn.mock.calls[0][2].defaults.decimals).toBe(2);
      expect(mockFn.mock.calls[0][2].overrides).toHaveLength(2);
      //removed custom property
      expect(mockFn.mock.calls[0][2].overrides[1].properties).toHaveLength(0);
      //removed fieldConfig custom values as well
      expect(mockFn.mock.calls[0][2].defaults.custom).toStrictEqual({});
    });

    it('Should merge fieldConfig overrides when fieldConfig is provided in options', async () => {
      const { optionsPane, panel } = setupTest('panel-1');

      const originalFieldConfig = {
        defaults: { unit: 'bytes' },
        overrides: [
          {
            matcher: { id: 'byName', options: 'A-series' },
            properties: [{ id: 'displayName', value: 'Original Override' }],
          },
        ],
      };

      panel.setState({ fieldConfig: originalFieldConfig });

      const mockOnFieldConfigChange = jest.fn();
      panel.onFieldConfigChange = mockOnFieldConfigChange;

      // Call onChangePanel with fieldConfig that has overrides
      await optionsPane.onChangePanel({
        pluginId: 'table',
        fieldConfig: {
          defaults: { unit: 'percent' },
          overrides: [],
        },
      });

      // Verify onFieldConfigChange was called with merged overrides
      expect(mockOnFieldConfigChange).toHaveBeenCalled();

      const mergedConfig = mockOnFieldConfigChange.mock.calls[0][0];

      // Should have both original and new overrides
      expect(mergedConfig.overrides).toHaveLength(1);

      // First override should be from the original (filtered) fieldConfig
      expect(mergedConfig.overrides[0].matcher).toEqual({ id: 'byName', options: 'A-series' });
      expect(mergedConfig.overrides[0].properties[0].id).toBe('displayName');

      // Should use the new fieldConfig defaults
      expect(mergedConfig.defaults.unit).toBe('percent');
    });

    it('Should not call onFieldConfigChange when no fieldConfig provided', async () => {
      const { optionsPane, panel } = setupTest('panel-1');

      const mockOnFieldConfigChange = jest.fn();
      panel.onFieldConfigChange = mockOnFieldConfigChange;

      // Call without fieldConfig
      await optionsPane.onChangePanel({
        pluginId: 'table',
        options: { showHeader: false },
      });

      expect(mockOnFieldConfigChange).not.toHaveBeenCalled();
    });

    it('keeps the picker open and applies suggestion configuration after the plugin changes', async () => {
      const { optionsPane, panel } = setupTest('panel-1');
      optionsPane.setState({ isVizPickerOpen: true });
      const calls: string[] = [];
      let finishPluginChange!: () => void;
      panel.changePluginType = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            calls.push('plugin-change-started');
            finishPluginChange = () => {
              calls.push('plugin-change-finished');
              resolve();
            };
          })
      );
      panel.onOptionsChange = jest.fn(() => calls.push('options-applied'));
      panel.onFieldConfigChange = jest.fn(() => calls.push('field-config-applied'));

      const change = optionsPane.onChangePanel({
        pluginId: 'barchart',
        options: { orientation: 'horizontal' },
        fieldConfig: { defaults: {}, overrides: [] },
      });
      await new Promise(process.nextTick);

      expect(calls).toEqual(['plugin-change-started']);
      expect(optionsPane.state.isVizPickerOpen).toBe(true);

      finishPluginChange();
      await change;

      expect(calls).toEqual([
        'plugin-change-started',
        'plugin-change-finished',
        'options-applied',
        'field-config-applied',
      ]);
      expect(optionsPane.state.isVizPickerOpen).toBe(false);
    });

    it('completes a started visualization change and coalesces queued changes to the latest', async () => {
      const { optionsPane, panel } = setupTest('panel-1');
      const finishPluginChanges: Array<() => void> = [];
      panel.changePluginType = jest.fn(
        (pluginId: string) =>
          new Promise<void>((resolve) => {
            finishPluginChanges.push(() => {
              panel.setState({ pluginId });
              resolve();
            });
          })
      );
      panel.onOptionsChange = jest.fn();

      const first = optionsPane.onChangePanel({
        pluginId: 'barchart',
        options: { orientation: 'horizontal' },
        withModKey: true,
      });
      await new Promise(process.nextTick);
      const superseded = optionsPane.onChangePanel({
        pluginId: 'table',
        options: { showHeader: true },
        withModKey: true,
      });
      const latest = optionsPane.onChangePanel({
        pluginId: 'timeseries',
        options: { legend: { showLegend: false } },
        withModKey: true,
      });

      expect(panel.changePluginType).toHaveBeenCalledTimes(1);
      expect(panel.changePluginType).toHaveBeenLastCalledWith('barchart', undefined, expect.any(Object));

      finishPluginChanges[0]();
      await first;
      await new Promise(process.nextTick);

      expect(panel.changePluginType).toHaveBeenCalledTimes(2);
      expect(panel.changePluginType).toHaveBeenLastCalledWith('timeseries', expect.any(Object), expect.any(Object));

      finishPluginChanges[1]();
      await Promise.all([superseded, latest]);

      expect(panel.state.pluginId).toBe('timeseries');
      expect(panel.onOptionsChange).toHaveBeenCalledTimes(2);
      expect(panel.onOptionsChange).toHaveBeenNthCalledWith(1, { orientation: 'horizontal' }, true);
      expect(panel.onOptionsChange).toHaveBeenNthCalledWith(2, { legend: { showLegend: false } }, true);
    });

    it('finishes the active visualization change and drops queued changes when panel edit closes', async () => {
      const { optionsPane, panel } = setupTest('panel-1');
      let finishPluginChange!: () => void;
      panel.changePluginType = jest.fn(
        (pluginId: string) =>
          new Promise<void>((resolve) => {
            finishPluginChange = () => {
              panel.setState({ pluginId });
              resolve();
            };
          })
      );
      panel.onOptionsChange = jest.fn();

      const started = optionsPane.onChangePanel({
        pluginId: 'barchart',
        options: { orientation: 'horizontal' },
      });
      await new Promise(process.nextTick);
      const queued = optionsPane.onChangePanel({ pluginId: 'table' });
      const completion = optionsPane.cancelPendingPanelChanges();
      finishPluginChange();
      await Promise.all([started, queued, completion]);

      expect(panel.changePluginType).toHaveBeenCalledTimes(1);
      expect(panel.state.pluginId).toBe('barchart');
      expect(panel.onOptionsChange).toHaveBeenCalledWith({ orientation: 'horizontal' }, true);
    });
  });
});

function setupTest(panelId: string) {
  const scene = transformSaveModelToScene({ dashboard: testDashboard, meta: {} });
  const panel = findVizPanelByKey(scene, panelId)!;

  const optionsPane = new PanelOptionsPane({ panelRef: panel.getRef(), listMode: OptionFilter.All, searchQuery: '' });

  // The following happens on DahsboardScene activation. For the needs of this test this activation aint needed hence we hand-call it
  // @ts-expect-error
  getDashboardSrv().setCurrent(new DashboardModelCompatibilityWrapper(scene));

  return { optionsPane, scene, panel };
}
