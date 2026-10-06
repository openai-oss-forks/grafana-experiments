// Trusted types must be initialized before modules with import-time side effects.
import '../core/trustedTypePolicies';
import 'symbol-observable';
import 'regenerator-runtime/runtime';

import { OpenFeatureProvider } from '@openfeature/react-sdk';
import { UNSAFE_PortalProvider } from '@react-aria/overlays';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { Router } from 'react-router-dom';
import { CompatRouter, Route, Routes, useLocation } from 'react-router-dom-v5-compat';

import {
  locationUtil,
  setLocale,
  setTimeZoneResolver,
  setWeekStart,
  standardTransformersRegistry,
  standardEditorsRegistry,
  standardFieldConfigEditorRegistry,
} from '@grafana/data';
import { DEFAULT_LANGUAGE } from '@grafana/i18n';
import { initializeI18n, loadNamespacedResources } from '@grafana/i18n/internal';
import {
  locationService,
  LocationServiceProvider,
  locationSearchToObject,
  setAppEvents,
  setBackendSrv,
  setCurrentUser,
  setDataSourceSrv,
  setLocationSrv,
  setPluginImportUtils,
  setQueryRunnerFactory,
  setRunRequest,
  setPluginComponentHook,
  setPluginComponentsHook,
  setPluginLinksHook,
  setPluginFunctionsHook,
} from '@grafana/runtime';
import {
  getFeatureFlagClient,
  initOpenFeature,
  setPanelRenderer,
  setPanelDataErrorView,
  setGetObservablePluginComponents,
  setGetObservablePluginLinks,
} from '@grafana/runtime/internal';
import { loadResources as loadScenesResources, sceneUtils } from '@grafana/scenes';
import { ErrorBoundaryAlert, GlobalStyles, getPortalContainer, PortalContainer } from '@grafana/ui';
import { appEvents } from 'app/core/app_events';
import { AppChromeService } from 'app/core/components/AppChrome/AppChromeService';
import { getAllOptionEditors, getAllStandardFieldConfigs } from 'app/core/components/OptionsUI/registry';
import config, { updateConfig } from 'app/core/config';
import { GrafanaContext, GrafanaContextType } from 'app/core/context/GrafanaContext';
import { ModalsContextProvider } from 'app/core/context/ModalsContextProvider';
import { GRAFANA_NAMESPACE, NAMESPACES } from 'app/core/internationalization/constants';
import { loadTranslations } from 'app/core/internationalization/loadTranslations';
import { NewFrontendAssetsChecker } from 'app/core/services/NewFrontendAssetsChecker';
import { backendSrv } from 'app/core/services/backend_srv';
import { contextSrv } from 'app/core/services/context_srv';
import { initEchoSrv } from 'app/core/services/echo/init';
import { KeybindingSrv } from 'app/core/services/keybindingSrv';
import { ThemeProvider } from 'app/core/utils/ConfigProvider';
import { getTimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { DashboardLevelTimeMacro } from 'app/features/dashboard-scene/scene/DashboardLevelTimeMacro';
import SoloPanelPage from 'app/features/dashboard-scene/solo/SoloPanelPage';
import { initGrafanaLive } from 'app/features/live';
import { PanelDataErrorView } from 'app/features/panel/components/PanelDataErrorView';
import { PanelRenderer } from 'app/features/panel/components/PanelRenderer';
import { DatasourceSrv } from 'app/features/plugins/datasource_srv';
import { ExtensionRegistriesProvider } from 'app/features/plugins/extensions/ExtensionRegistriesContext';
import {
  getObservablePluginComponents,
  getObservablePluginLinks,
} from 'app/features/plugins/extensions/getPluginExtensions';
import { getPluginExtensionRegistries } from 'app/features/plugins/extensions/registry/setup';
import { usePluginComponent } from 'app/features/plugins/extensions/usePluginComponent';
import { usePluginComponents } from 'app/features/plugins/extensions/usePluginComponents';
import { usePluginFunctions } from 'app/features/plugins/extensions/usePluginFunctions';
import { usePluginLinks } from 'app/features/plugins/extensions/usePluginLinks';
import { hasPanelPlugin, importPanelPlugin, syncGetPanelPlugin } from 'app/features/plugins/importPanelPlugin';
import { initSystemJSHooks } from 'app/features/plugins/loader/systemjsHooks';
import { QueryRunner } from 'app/features/query/state/QueryRunner';
import { runRequest } from 'app/features/query/state/runRequest';
import { ScopesContextProvider } from 'app/features/scopes/ScopesContextProvider';
import { getStandardTransformers } from 'app/features/transformers/standardTransformers';
import { variableAdapters } from 'app/features/variables/adapters';
import { createAdHocVariableAdapter } from 'app/features/variables/adhoc/adapter';
import { createConstantVariableAdapter } from 'app/features/variables/constant/adapter';
import { createCustomVariableAdapter } from 'app/features/variables/custom/adapter';
import { createDataSourceVariableAdapter } from 'app/features/variables/datasource/adapter';
import { getVariablesUrlParams } from 'app/features/variables/getAllVariableValuesForUrl';
import { createIntervalVariableAdapter } from 'app/features/variables/interval/adapter';
import { setVariableQueryRunner, VariableQueryRunner } from 'app/features/variables/query/VariableQueryRunner';
import { createQueryVariableAdapter } from 'app/features/variables/query/adapter';
import { createSwitchVariableAdapter } from 'app/features/variables/switch/adapter';
import { createSystemVariableAdapter } from 'app/features/variables/system/adapter';
import { createTextBoxVariableAdapter } from 'app/features/variables/textbox/adapter';
import { configureStore } from 'app/store/configureStore';
import { store } from 'app/store/store';
import { DashboardRoutes } from 'app/types/dashboard';

const route = {
  path: '/d-solo/:uid/:slug?',
  routeName: DashboardRoutes.Embedded,
  chromeless: true,
  component: EmbeddedPanelRoute,
};

function EmbeddedPanelRoute() {
  const location = useLocation();
  const queryParams = locationSearchToObject(location.search);
  return (
    <SoloPanelPage
      route={route}
      location={location}
      queryParams={{ ...queryParams, panelId: String(queryParams.panelId ?? '') }}
    />
  );
}

export async function initEmbeddedApp() {
  // Retain the old dashboard implementation when scenes are disabled.
  if (!config.featureToggles.dashboardScene && !config.featureToggles.dashboardNewLayouts) {
    await import('../initApp');
    return;
  }

  performance.mark('embedded_app_init');
  window.parent.postMessage('GrafanaAppInit', '*');
  initSystemJSHooks();
  setBackendSrv(backendSrv);
  setAppEvents(appEvents);
  setCurrentUser(contextSrv.user);
  setLocationSrv(locationService);
  setLocale(config.regionalFormat);
  setWeekStart(contextSrv.user.weekStart);
  setTimeZoneResolver(() => contextSrv.user.timezone);
  setPanelRenderer(PanelRenderer);
  setPanelDataErrorView(PanelDataErrorView);
  setPluginImportUtils({ importPanelPlugin, getPanelPluginFromCache: syncGetPanelPlugin });
  standardEditorsRegistry.setInit(getAllOptionEditors);
  standardFieldConfigEditorRegistry.setInit(getAllStandardFieldConfigs);
  standardTransformersRegistry.setInit(getStandardTransformers);
  variableAdapters.setInit(() => [
    createQueryVariableAdapter(),
    createCustomVariableAdapter(),
    createTextBoxVariableAdapter(),
    createConstantVariableAdapter(),
    createDataSourceVariableAdapter(),
    createIntervalVariableAdapter(),
    createAdHocVariableAdapter(),
    createSystemVariableAdapter(),
    createSwitchVariableAdapter(),
  ]);
  setQueryRunnerFactory(() => new QueryRunner());
  setVariableQueryRunner(new VariableQueryRunner());
  setRunRequest(runRequest);
  initGrafanaLive();

  // Start these independently. Feature-provider/telemetry round trips must not
  // gate the first dashboard request. Server-evaluated featureToggles remain available.
  void initEchoSrv();
  if (contextSrv.user.isSignedIn) {
    void initOpenFeature().catch((error) => console.error('Failed to initialize OpenFeature provider', error));
  }

  const regionalFormat = config.featureToggles.localeFormatPreference
    ? config.regionalFormat
    : contextSrv.user.language;
  const { language } = await initializeI18n(
    { language: contextSrv.user.language, ns: NAMESPACES, module: loadTranslations },
    regionalFormat
  );
  updateConfig({ language });
  await loadNamespacedResources(GRAFANA_NAMESPACE, language ?? DEFAULT_LANGUAGE, [loadScenesResources]);
  configureStore();
  locationUtil.initialize({
    config: window.grafanaBootData.settings,
    getTimeRangeForUrl: getTimeSrv().timeRangeForUrl,
    getVariablesUrlParams,
  });
  const datasourceSrv = new DatasourceSrv();
  datasourceSrv.init(config.datasources, config.defaultDatasource);
  setDataSourceSrv(datasourceSrv);

  // Warm the common chart renderer immediately rather than discovering its
  // asynchronous module only after dashboard/variable initialization completes.
  if (hasPanelPlugin('timeseries')) {
    void importPanelPlugin('timeseries').catch((error) => console.error('Failed to preload time series panel', error));
  }

  const registries = await getPluginExtensionRegistries();
  setPluginComponentHook(usePluginComponent);
  setPluginComponentsHook(usePluginComponents);
  setPluginLinksHook(usePluginLinks);
  setPluginFunctionsHook(usePluginFunctions);
  setGetObservablePluginComponents(getObservablePluginComponents);
  setGetObservablePluginLinks(getObservablePluginLinks);

  if (config.featureToggles.dashboardLevelTimeMacros) {
    sceneUtils.registerVariableMacro('__from', DashboardLevelTimeMacro, true);
    sceneUtils.registerVariableMacro('__to', DashboardLevelTimeMacro, true);
  }
  const chrome = new AppChromeService();
  chrome.setMatchedRoute(route);
  const context: GrafanaContextType = {
    backend: backendSrv,
    location: locationService,
    config,
    chrome,
    keybindings: new KeybindingSrv(locationService, chrome),
    newAssetsChecker: new NewFrontendAssetsChecker(),
  };

  createRoot(document.getElementById('reactRoot')!).render(
    <Provider store={store}>
      <ErrorBoundaryAlert boundaryName="embedded-panel" style="page">
        <OpenFeatureProvider client={getFeatureFlagClient()}>
          <GrafanaContext.Provider value={context}>
            <ThemeProvider value={config.theme2}>
              <Router history={locationService.getHistory()}>
                <LocationServiceProvider service={locationService}>
                  <CompatRouter>
                    <ScopesContextProvider>
                      <ExtensionRegistriesProvider registries={registries}>
                        <ModalsContextProvider>
                          <UNSAFE_PortalProvider getContainer={getPortalContainer}>
                            <GlobalStyles />
                            <Routes>
                              <Route path={route.path} element={<EmbeddedPanelRoute />} />
                            </Routes>
                            <PortalContainer />
                          </UNSAFE_PortalProvider>
                        </ModalsContextProvider>
                      </ExtensionRegistriesProvider>
                    </ScopesContextProvider>
                  </CompatRouter>
                </LocationServiceProvider>
              </Router>
            </ThemeProvider>
          </GrafanaContext.Provider>
        </OpenFeatureProvider>
      </ErrorBoundaryAlert>
    </Provider>
  );
  document.querySelector('.preloader')?.remove();
  performance.mark('embedded_app_ready');
}
