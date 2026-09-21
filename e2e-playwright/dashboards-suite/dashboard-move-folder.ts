import { APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';

import { test, expect } from '@grafana/plugin-e2e';

export function testDashboardMoveFolder(apiVersion: 'v1beta1' | 'v2beta1'): void {
  test.describe(`${apiVersion} dashboard moves`, { tag: ['@dashboards'] }, () => {
    for (const selection of ['folder browse', 'changed search results']) {
      test(`does not offer General for a named-folder dashboard selected from ${selection}`, async ({
        page,
        request,
        namespace,
        selectors,
      }) => {
        const suffix = randomUUID().slice(0, 8);
        const source = { uid: `source-${suffix}`, title: `000 Move source ${suffix}` };
        const destination = { uid: `destination-${suffix}`, title: `000 Move destination ${suffix}` };
        const dashboardUid = `move-${suffix}`;
        const dashboardTitle = `Move dashboard ${suffix}`;
        const resourceUrl = `/apis/dashboard.grafana.app/${apiVersion}/namespaces/${namespace}/dashboards`;
        const dashboardUrl = `${resourceUrl}/${dashboardUid}`;

        try {
          for (const folder of [source, destination]) {
            await expect(await request.post('/api/folders', { data: folder })).toBeOK();
          }
          await createDashboard(request, resourceUrl, apiVersion, dashboardUid, dashboardTitle, source.uid);

          if (selection === 'folder browse') {
            await page.goto(`/dashboards/f/${source.uid}`);
            await page
              .getByTestId(selectors.pages.BrowseDashboards.table.checkbox(dashboardUid))
              .check({ force: true });
          } else {
            await page.goto('/dashboards');
            const search = page.getByPlaceholder('Search for dashboards and folders');
            await search.fill(dashboardTitle);
            const results = page.getByRole('table', { name: 'Search results table' });
            await results
              .getByRole('row')
              .filter({ has: page.getByRole('link', { name: dashboardTitle, exact: true }) })
              .getByRole('checkbox')
              .check({ force: true });
            await search.fill(destination.title);
            await expect(results.getByRole('link', { name: destination.title, exact: true })).toBeVisible();
            await expect(results.getByRole('link', { name: dashboardTitle, exact: true })).toHaveCount(0);
          }

          const folderCheck = page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname ===
                `/apis/dashboard.grafana.app/v1beta1/namespaces/${namespace}/dashboards/${dashboardUid}` &&
              response.request().headers()['accept'] === 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1',
            { timeout: 10000 }
          );
          await page.getByTestId('manage-actions').getByRole('button', { name: 'Move', exact: true }).click();
          const folderResponse = await folderCheck;
          expect(folderResponse.ok()).toBe(true);
          const metadata = await folderResponse.json();
          expect(metadata).toMatchObject({
            apiVersion: 'meta.k8s.io/v1',
            kind: 'PartialObjectMetadata',
            metadata: { name: dashboardUid, annotations: { 'grafana.app/folder': source.uid } },
          });
          expect(metadata).not.toHaveProperty('spec');
          const dialog = page.getByRole('dialog', { name: 'Move', exact: true });
          await expect(dialog.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
          await expect(dialog.getByText('Could not check dashboard folders', { exact: true })).toHaveCount(0);
          await dialog.getByRole('button', { name: 'Select folder', exact: true }).click();
          const target = dialog.getByRole('treeitem', { name: destination.title, exact: true });
          await expect(target).toBeVisible();
          await expect(dialog.getByRole('treeitem', { name: 'Dashboards', exact: true })).toHaveCount(0);

          await target.click();
          await dialog.getByRole('button', { name: 'Move', exact: true }).click();
          await expect(dialog).toBeHidden();
          const moved = await request.get(dashboardUrl);
          await expect(moved).toBeOK();
          expect(await moved.json()).toMatchObject({
            metadata: { name: dashboardUid, annotations: { 'grafana.app/folder': destination.uid } },
            spec: { title: dashboardTitle },
          });
        } finally {
          for (const url of [dashboardUrl, `/api/folders/${source.uid}`, `/api/folders/${destination.uid}`]) {
            const response = await request.delete(url);
            expect.soft([200, 404], `DELETE ${url}`).toContain(response.status());
          }
        }
      });
    }

    test('keeps General unavailable when a selected dashboard was deleted', async ({ page, request, namespace }) => {
      const suffix = randomUUID().slice(0, 8);
      const destination = { uid: `destination-${suffix}`, title: `000 Move destination ${suffix}` };
      const dashboardUid = `move-${suffix}`;
      const dashboardTitle = `Move dashboard ${suffix}`;
      const resourceUrl = `/apis/dashboard.grafana.app/${apiVersion}/namespaces/${namespace}/dashboards`;
      const dashboardUrl = `${resourceUrl}/${dashboardUid}`;

      try {
        await expect(await request.post('/api/folders', { data: destination })).toBeOK();
        await createDashboard(request, resourceUrl, apiVersion, dashboardUid, dashboardTitle, '');
        await page.goto('/dashboards');
        await page.getByPlaceholder('Search for dashboards and folders').fill(dashboardTitle);
        await page
          .getByRole('table', { name: 'Search results table' })
          .getByRole('row')
          .filter({ has: page.getByRole('link', { name: dashboardTitle, exact: true }) })
          .getByRole('checkbox')
          .check({ force: true });
        await expect(await request.delete(dashboardUrl)).toBeOK();

        const folderCheck = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname ===
              `/apis/dashboard.grafana.app/v1beta1/namespaces/${namespace}/dashboards/${dashboardUid}` &&
            response.request().headers()['accept'] === 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1',
          { timeout: 10000 }
        );
        await page.getByTestId('manage-actions').getByRole('button', { name: 'Move', exact: true }).click();
        const response = await folderCheck;
        expect(response.ok()).toBe(false);
        expect(await response.text()).toMatch(/not found/i);
        const dialog = page.getByRole('dialog', { name: 'Move', exact: true });
        await expect(dialog.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
        await expect(dialog.getByText('Could not check dashboard folders', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Select folder', exact: true }).click();
        const target = dialog.getByRole('treeitem', { name: destination.title, exact: true });
        await expect(target).toBeVisible();
        await expect(dialog.getByRole('treeitem', { name: 'Dashboards', exact: true })).toHaveCount(0);
        await target.click();
        await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      } finally {
        for (const url of [dashboardUrl, `/api/folders/${destination.uid}`]) {
          const response = await request.delete(url);
          expect.soft([200, 404], `DELETE ${url}`).toContain(response.status());
        }
      }
    });

    for (const selection of ['folder with expanded dashboards', 'folder and General dashboard']) {
      test(`allows moving a ${selection} to General`, async ({ page, request, namespace, selectors }) => {
        const suffix = randomUUID().slice(0, 8);
        const parent = { uid: `parent-${suffix}`, title: `000 Move parent ${suffix}` };
        const child = { uid: `child-${suffix}`, title: `Move child ${suffix}`, parentUid: parent.uid };
        const dashboardUid = `move-${suffix}`;
        const dashboardTitle = `Move dashboard ${suffix}`;
        const dashboardFolderUid = selection === 'folder with expanded dashboards' ? child.uid : '';
        const resourceUrl = `/apis/dashboard.grafana.app/${apiVersion}/namespaces/${namespace}/dashboards`;
        const dashboardUrl = `${resourceUrl}/${dashboardUid}`;

        try {
          for (const folder of [parent, child]) {
            await expect(await request.post('/api/folders', { data: folder })).toBeOK();
          }
          await createDashboard(request, resourceUrl, apiVersion, dashboardUid, dashboardTitle, dashboardFolderUid);

          if (selection === 'folder with expanded dashboards') {
            await page.goto(`/dashboards/f/${parent.uid}`);
            await page.getByRole('button', { name: `Expand folder ${child.title}`, exact: true }).click();
            const dashboardCheckbox = page.getByTestId(selectors.pages.BrowseDashboards.table.checkbox(dashboardUid));
            await expect(dashboardCheckbox).toBeVisible();
            await page.getByTestId(selectors.pages.BrowseDashboards.table.checkbox(child.uid)).check({ force: true });
            await expect(dashboardCheckbox).toBeChecked();
          } else {
            await page.goto('/dashboards');
            await page.getByPlaceholder('Search for dashboards and folders').fill(suffix);
            const results = page.getByRole('table', { name: 'Search results table' });
            for (const title of [child.title, dashboardTitle]) {
              await results
                .getByRole('row')
                .filter({ has: page.getByRole('link', { name: title, exact: true }) })
                .getByRole('checkbox')
                .check({ force: true });
            }
          }

          const beforeMove = await request.get(`/api/folders/${child.uid}`);
          await expect(beforeMove).toBeOK();
          expect(await beforeMove.json()).toMatchObject({ parentUid: parent.uid });

          await page.getByTestId('manage-actions').getByRole('button', { name: 'Move', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Move', exact: true });
          await dialog.getByRole('button', { name: 'Select folder', exact: true }).click();
          await expect(dialog.getByRole('treeitem', { name: parent.title, exact: true })).toBeVisible();
          await dialog.getByRole('treeitem', { name: 'Dashboards', exact: true }).click();
          await dialog.getByRole('button', { name: 'Move', exact: true }).click();
          await expect(dialog).toBeHidden();

          const moved = await request.get(`/api/folders/${child.uid}`);
          await expect(moved).toBeOK();
          expect((await moved.json()).parentUid ?? '').toBe('');
          const dashboard = await request.get(dashboardUrl);
          await expect(dashboard).toBeOK();
          const resource = await dashboard.json();
          expect(resource.spec.title).toBe(dashboardTitle);
          expect(resource.metadata.annotations?.['grafana.app/folder'] ?? '').toBe(dashboardFolderUid);
        } finally {
          for (const url of [dashboardUrl, `/api/folders/${child.uid}`, `/api/folders/${parent.uid}`]) {
            const response = await request.delete(url);
            expect.soft([200, 404], `DELETE ${url}`).toContain(response.status());
          }
        }
      });
    }
  });
}

async function createDashboard(
  request: APIRequestContext,
  resourceUrl: string,
  apiVersion: 'v1beta1' | 'v2beta1',
  uid: string,
  title: string,
  folderUid: string
): Promise<void> {
  const response = await request.post(resourceUrl, {
    data: {
      apiVersion: `dashboard.grafana.app/${apiVersion}`,
      kind: 'Dashboard',
      metadata: { name: uid, annotations: { 'grafana.app/folder': folderUid } },
      spec: {
        title,
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
      },
    },
  });
  await expect(response).toBeOK();
}
