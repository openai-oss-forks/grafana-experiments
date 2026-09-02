import { request as playwrightRequest } from '@playwright/test';
import { randomUUID } from 'crypto';

import { test, expect } from '@grafana/plugin-e2e';

test.use({
  featureToggles: {
    kubernetesDashboards: false,
    dashboardNewLayouts: false,
  },
});

for (const pluginId of ['', 'restore-test-plugin']) {
  test(
    `restoring ${pluginId ? 'a plugin' : 'a'} dashboard version preserves its folder and inherited access`,
    { tag: ['@dashboards'] },
    async ({ page, request, baseURL, namespace }) => {
      const suffix = randomUUID().slice(0, 8);
      const dashboardUid = `restore-${suffix}`;
      const folderUid = `folder-${suffix}`;
      const login = `restore-viewer-${suffix}`;
      const password = randomUUID();
      const viewer = await playwrightRequest.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
        httpCredentials: undefined,
      });
      let userId: number | undefined;

      try {
        const createUser = await request.post('/api/admin/users', {
          data: { login, name: login, password },
        });
        await expect(createUser).toBeOK();
        userId = (await createUser.json()).id;
        await expect(await request.patch(`/api/org/users/${userId}`, { data: { role: 'Viewer' } })).toBeOK();

        await expect(
          await request.post('/api/folders', { data: { uid: folderUid, title: `Restore folder ${suffix}` } })
        ).toBeOK();
        await expect(
          await request.post(`/api/folders/${folderUid}/permissions`, {
            data: { items: [{ userId, permission: 1 }] },
          })
        ).toBeOK();

        const dashboard = {
          title: `Restore dashboard ${suffix}`,
          description: 'Initial description',
          schemaVersion: 42,
          panels: [],
        };
        const resourceUrl = `/apis/dashboard.grafana.app/v1beta1/namespaces/${namespace}/dashboards`;
        const created = await request.post(resourceUrl, {
          data: {
            apiVersion: 'dashboard.grafana.app/v1beta1',
            kind: 'Dashboard',
            metadata: {
              name: dashboardUid,
              annotations: {
                'grafana.app/folder': folderUid,
                'grafana.app/grant-permissions': 'default',
                ...(pluginId ? { 'grafana.app/managedBy': 'plugin', 'grafana.app/managerId': pluginId } : {}),
              },
            },
            spec: dashboard,
          },
        });
        await expect(created).toBeOK();
        const resource = await created.json();
        resource.spec.description = 'Updated description';
        const updated = await request.put(`${resourceUrl}/${dashboardUid}`, { data: resource });
        await expect(updated).toBeOK();
        if (pluginId) {
          expect((await updated.json()).metadata.annotations).toMatchObject({
            'grafana.app/managedBy': 'plugin',
            'grafana.app/managerId': pluginId,
          });
        }

        await expect(
          await request.post(`/api/dashboards/uid/${dashboardUid}/permissions`, { data: { items: [] } })
        ).toBeOK();

        await expect(await viewer.post('/login', { data: { user: login, password } })).toBeOK();
        const identity = await viewer.get('/api/user');
        await expect(identity).toBeOK();
        expect(await identity.json()).toMatchObject({ id: userId, isGrafanaAdmin: false });

        const dashboardUrl = `/api/dashboards/uid/${dashboardUid}`;
        const before = await viewer.get(dashboardUrl);
        await expect(before).toBeOK();
        await page.goto(`/d/${dashboardUid}?editview=versions`);
        await page.getByRole('button', { name: 'Restore', exact: true }).click();
        await page.getByRole('button', { name: 'Yes, restore to version 1', exact: true }).click();
        await expect(page.getByText('Dashboard restored', { exact: true })).toBeVisible();

        const restored = await viewer.get(dashboardUrl);
        await expect(restored).toBeOK();
        expect(await restored.json()).toMatchObject({
          dashboard: { uid: dashboardUid, description: 'Initial description', version: 3 },
          meta: { folderUid },
        });
      } finally {
        await viewer.dispose();
        const cleanupUrls = [`/api/dashboards/uid/${dashboardUid}`, `/api/folders/${folderUid}`];
        if (userId !== undefined) {
          cleanupUrls.push(`/api/admin/users/${userId}`);
        }
        for (const url of cleanupUrls) {
          const response = await request.delete(url);
          expect.soft([200, 404], `DELETE ${url}`).toContain(response.status());
        }
      }
    }
  );
}
