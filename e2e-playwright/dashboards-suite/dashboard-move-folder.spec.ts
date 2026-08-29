import { test } from '@grafana/plugin-e2e';

import { testDashboardMoveFolder } from './dashboard-move-folder';

test.use({
  featureToggles: {
    kubernetesDashboards: true,
    dashboardScene: true,
    dashboardNewLayouts: false,
    provisioning: false,
    teamFolders: false,
  },
});

testDashboardMoveFolder('v1beta1');
