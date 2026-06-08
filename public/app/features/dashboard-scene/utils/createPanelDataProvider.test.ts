import { SceneDataTransformer } from '@grafana/scenes';
import { PanelModel } from 'app/features/dashboard/state/PanelModel';

import { DashboardSceneQueryRunner } from '../scene/DashboardSceneQueryRunner';

import { createPanelDataProvider } from './createPanelDataProvider';

describe('createPanelDataProvider', () => {
  test('uses the query runner directly when the panel has no transformations', () => {
    const provider = createPanelDataProvider(createPanel([]));

    expect(provider).toBeInstanceOf(DashboardSceneQueryRunner);
  });

  test('wraps the query runner when transformations must be preserved', () => {
    const provider = createPanelDataProvider(createPanel([{ id: 'reduce', options: {} }]));

    expect(provider).toBeInstanceOf(SceneDataTransformer);
    expect((provider as SceneDataTransformer).state.$data).toBeInstanceOf(DashboardSceneQueryRunner);
  });
});

function createPanel(transformations: PanelModel['transformations']) {
  return new PanelModel({
    id: 1,
    title: 'Panel',
    type: 'timeseries',
    targets: [{ refId: 'A' }],
    transformations,
  });
}
