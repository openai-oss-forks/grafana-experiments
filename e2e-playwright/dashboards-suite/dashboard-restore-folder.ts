import { request as playwrightRequest } from '@playwright/test';
import { randomUUID } from 'crypto';

import { test, expect } from '@grafana/plugin-e2e';

export function testDashboardRestoreFolder(apiVersion: 'v1beta1' | 'v2beta1'): void {
  for (const sourceFolder of ['General', 'named folder']) {
    test(
      `${apiVersion}: restoring a version from ${sourceFolder} preserves the current folder and inherited access`,
      { tag: ['@dashboards'] },
      async ({ page, request, baseURL, namespace }) => {
        const suffix = randomUUID().slice(0, 8);
        const dashboardUid = `restore-${suffix}`;
        const folderUid = `folder-${suffix}`;
        const sourceFolderUid = sourceFolder === 'General' ? '' : `source-${suffix}`;
        const resourceUrl = `/apis/dashboard.grafana.app/${apiVersion}/namespaces/${namespace}/dashboards`;
        const dashboardUrl = `${resourceUrl}/${dashboardUid}`;
        const login = `restore-viewer-${suffix}`;
        const password = randomUUID();
        const viewer = await playwrightRequest.newContext({
          baseURL,
          storageState: { cookies: [], origins: [] },
          httpCredentials: undefined,
        });
        let userId: number | undefined;

        try {
          const createUser = await request.post('/api/admin/users', { data: { login, name: login, password } });
          await expect(createUser).toBeOK();
          userId = (await createUser.json()).id;
          await expect(await request.patch(`/api/org/users/${userId}`, { data: { role: 'Viewer' } })).toBeOK();

          if (sourceFolderUid) {
            await expect(
              await request.post('/api/folders', { data: { uid: sourceFolderUid, title: `Source folder ${suffix}` } })
            ).toBeOK();
            await expect(
              await request.post(`/api/folders/${sourceFolderUid}/permissions`, { data: { items: [] } })
            ).toBeOK();
          }
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
            ...(apiVersion === 'v1beta1'
              ? { schemaVersion: 42, panels: [] }
              : {
                  annotations: [],
                  cursorSync: 'Off',
                  editable: true,
                  elements: {},
                  layout: { kind: 'GridLayout', spec: { items: [] } },
                  links: [],
                  preload: false,
                  tags: [],
                  timeSettings: {
                    from: 'now-6h',
                    to: 'now',
                    autoRefresh: '',
                    autoRefreshIntervals: [],
                    hideTimepicker: false,
                    timezone: 'browser',
                    fiscalYearStartMonth: 0,
                  },
                  variables: [],
                }),
          };
          const created = await request.post(resourceUrl, {
            data: {
              apiVersion: `dashboard.grafana.app/${apiVersion}`,
              kind: 'Dashboard',
              metadata: { name: dashboardUid, annotations: { 'grafana.app/folder': sourceFolderUid } },
              spec: dashboard,
            },
          });
          await expect(created).toBeOK();
          const resource = await created.json();
          resource.metadata.annotations['grafana.app/folder'] = folderUid;
          resource.spec.description = 'Updated description';
          await expect(await request.put(dashboardUrl, { data: resource })).toBeOK();
          await expect(
            await request.post(`/api/dashboards/uid/${dashboardUid}/permissions`, { data: { items: [] } })
          ).toBeOK();

          await expect(await viewer.post('/login', { data: { user: login, password } })).toBeOK();
          const identity = await viewer.get('/api/user');
          await expect(identity).toBeOK();
          expect(await identity.json()).toMatchObject({ id: userId, isGrafanaAdmin: false });
          await expect(await viewer.get(dashboardUrl)).toBeOK();

          await page.goto(`/d/${dashboardUid}?editview=versions`);
          await page.getByRole('button', { name: 'Restore', exact: true }).click();
          await page.getByRole('button', { name: 'Yes, restore to version 1', exact: true }).click();
          await expect(page.getByText('Dashboard restored', { exact: true })).toBeVisible();

          const restored = await viewer.get(dashboardUrl);
          await expect(restored).toBeOK();
          expect(await restored.json()).toMatchObject({
            metadata: { name: dashboardUid, generation: 3, annotations: { 'grafana.app/folder': folderUid } },
            spec: { description: 'Initial description' },
          });
        } finally {
          await viewer.dispose();
          const cleanupUrls = [dashboardUrl, `/api/folders/${folderUid}`];
          if (sourceFolderUid) {
            cleanupUrls.push(`/api/folders/${sourceFolderUid}`);
          }
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
}
