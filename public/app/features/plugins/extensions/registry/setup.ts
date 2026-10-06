/* eslint-disable @grafana/i18n/no-untranslated-strings */
import { AppPluginConfig } from '@grafana/data';
import { config } from '@grafana/runtime';
import { getAppPluginMetas, getCachedPromise } from '@grafana/runtime/internal';

import { AddedComponentsRegistry } from './AddedComponentsRegistry';
import { AddedFunctionsRegistry } from './AddedFunctionsRegistry';
import { AddedLinksRegistry } from './AddedLinksRegistry';
import { ExposedComponentsRegistry } from './ExposedComponentsRegistry';
import { PluginExtensionRegistries } from './types';

function initRegistries(apps: AppPluginConfig[]): PluginExtensionRegistries {
  const addedComponentsRegistry = new AddedComponentsRegistry(apps);
  const exposedComponentsRegistry = new ExposedComponentsRegistry(apps);
  const addedLinksRegistry = new AddedLinksRegistry(apps);
  const addedFunctionsRegistry = new AddedFunctionsRegistry(apps);
  return { addedComponentsRegistry, addedFunctionsRegistry, addedLinksRegistry, exposedComponentsRegistry };
}

async function initPluginExtensionRegistries(): Promise<PluginExtensionRegistries> {
  const apps = await getAppPluginMetas();
  const registries = initRegistries(apps);
  // A solo panel has no application navigation or editor extension points.
  // Keep the core editor modules out of its initial dependency graph.
  const pathname = window.location.pathname;
  const appPath = pathname.startsWith(config.appSubUrl) ? pathname.slice(config.appSubUrl.length) : pathname;
  const embeddedScene =
    appPath.startsWith('/d-solo/') &&
    (config.featureToggles.dashboardScene || config.featureToggles.dashboardNewLayouts);
  if (!embeddedScene) {
    const { registerCoreExtensions } = await import('./registerCoreExtensions');
    registerCoreExtensions(registries);
  }

  return registries;
}

/**
 * Gets the plugin extension registries, initializing them on first call.
 * This function is safe to call concurrently - multiple simultaneous calls will
 * all receive the same Promise instance, ensuring only one initialization.
 * If initialization (including getAppPluginMetas) fails, the error is logged and
 * empty plugin extension registries are returned as a fallback.
 * @returns Promise resolving to the plugin extension registries
 */
export async function getPluginExtensionRegistries(): Promise<PluginExtensionRegistries> {
  return getCachedPromise(initPluginExtensionRegistries, { defaultValue: initRegistries([]) });
}
