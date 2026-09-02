import { test } from '@grafana/plugin-e2e';

import { testDashboardRestoreFolder } from './dashboard-restore-folder';

test.use({
  featureToggles: {
    kubernetesDashboards: true,
    dashboardScene: true,
    dashboardNewLayouts: true,
  },
});

testDashboardRestoreFolder('v2beta1');
