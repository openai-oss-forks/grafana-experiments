import { config } from '@grafana/runtime';
import { SceneDataProvider, SceneDataTransformer } from '@grafana/scenes';
import { DataQuery, DataSourceRef } from '@grafana/schema';
import { PanelModel } from 'app/features/dashboard/state/PanelModel';

import { DashboardDatasourceBehaviour } from '../scene/DashboardDatasourceBehaviour';
import { DashboardSceneQueryRunner } from '../scene/DashboardSceneQueryRunner';

export function createPanelDataProvider(panel: PanelModel): SceneDataProvider | undefined {
  // Skip setting query runner for panels without queries
  if (!panel.targets?.length) {
    return undefined;
  }

  // Skip setting query runner for panel plugins with skipDataQuery
  if (config.panels[panel.type]?.skipDataQuery) {
    return undefined;
  }

  let dataProvider: SceneDataProvider | undefined = undefined;

  dataProvider = new DashboardSceneQueryRunner({
    // If panel.datasource is not defined, we use the first datasource from the targets (queries)
    datasource: panel.datasource ?? findFirstDatasource(panel.targets),
    queries: panel.targets,
    maxDataPoints: panel.maxDataPoints ?? undefined,
    maxDataPointsFromWidth: true,
    cacheTimeout: panel.cacheTimeout,
    queryCachingTTL: panel.queryCachingTTL,
    minInterval: panel.interval ?? undefined,
    dataLayerFilter: {
      panelId: panel.id,
    },
    $behaviors: [new DashboardDatasourceBehaviour({})],
  });

  const transformations = panel.transformations ?? [];
  if (transformations.length === 0) {
    return dataProvider;
  }

  return new SceneDataTransformer({ $data: dataProvider, transformations });
}

function findFirstDatasource(targets: DataQuery[]): DataSourceRef | undefined {
  const datasource = targets.find((t) => Boolean(t.datasource))?.datasource;
  if (!datasource) {
    return undefined;
  }

  const dsRef: DataSourceRef = {
    ...(datasource?.type && { type: datasource?.type }),
    ...(datasource?.uid && { uid: datasource?.uid }),
  };

  return dsRef;
}
