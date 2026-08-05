import { defaults } from 'lodash';
import { lastValueFrom, Observable, throwError } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { gte } from 'semver';

import {
  AbstractQuery,
  AdHocVariableFilter,
  COMPACT_TIME_SERIES_FORMAT,
  CompactTimeSeriesAxis,
  CompactTimeSeriesData,
  CompactTimeSeriesMetadata,
  CompactTimeSeriesNotice,
  CompactTimeSeriesSeries,
  CoreApp,
  CustomVariableModel,
  DataFrame,
  DataQueryError,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceGetTagKeysOptions,
  DataSourceGetTagValuesOptions,
  DataSourceInstanceSettings,
  DataSourceWithQueryExportSupport,
  DataSourceWithQueryImportSupport,
  dateTime,
  FieldType,
  getDefaultTimeRange,
  LegacyMetricFindQueryOptions,
  Labels,
  LoadingState,
  MetricFindValue,
  QueryFixAction,
  QueryVariableModel,
  rangeUtil,
  ScopedVars,
  scopeFilterOperatorMap,
  ScopeSpecFilter,
  TimeRange,
} from '@grafana/data';
import {
  BackendSrvRequest,
  config,
  DataSourceWithBackend,
  FetchResponse,
  getBackendSrv,
  getTemplateSrv,
  isFetchError,
  TemplateSrv,
} from '@grafana/runtime';

import { addLabelToQuery } from './add_label_to_query';
import { PrometheusAnnotationSupport } from './annotations';
import { DEFAULT_SERIES_LIMIT, GET_AND_POST_METADATA_ENDPOINTS, InstantQueryRefIdIndex } from './constants';
import { interpolateQueryExpr, prometheusRegularEscape } from './escaping';
import {
  exportToAbstractQuery,
  importFromAbstractQuery,
  populateMatchParamsFromQueries,
  PrometheusLanguageProvider,
  PrometheusLanguageProviderInterface,
} from './language_provider';
import { expandRecordingRules, getPrometheusTime, getRangeSnapInterval } from './language_utils';
import { PrometheusMetricFindQuery } from './metric_find_query';
import { queryPrometheusMultiBatch } from './prometheusMultibatchStream';
import { getQueryHints } from './query_hints';
import { renderLabelsWithoutBrackets } from './querybuilder/shared/rendering/labels';
import { QueryBuilderLabelFilter, QueryEditorMode } from './querybuilder/shared/types';
import { CacheRequestInfo, defaultPrometheusQueryOverlapWindow, QueryCache } from './querycache/QueryCache';
import { transformV2 } from './result_transformer';
import { trackQuery } from './tracking';
import {
  ExemplarTraceIdDestination,
  PromApplication,
  PrometheusCacheLevel,
  PromOptions,
  PromQuery,
  PromQueryBuilderParseErrorHelp,
  PromQueryRequest,
  RawRecordingRules,
  RuleQueryMapping,
} from './types';
import { utf8Support, wrapUtf8Filters } from './utf8_support';
import { PrometheusVariableSupport } from './variables';

const MULTI_TARGET_BATCH_PUBLISH_DELAY_MS = 16;

export class PrometheusDatasource
  extends DataSourceWithBackend<PromQuery, PromOptions>
  implements DataSourceWithQueryImportSupport<PromQuery>, DataSourceWithQueryExportSupport<PromQuery>
{
  access: 'direct' | 'proxy';
  basicAuth: any;
  cache: QueryCache<PromQuery>;
  cacheLevel: PrometheusCacheLevel;
  customQueryParameters: URLSearchParams;
  datasourceConfigurationPrometheusFlavor?: PromApplication;
  datasourceConfigurationPrometheusVersion?: string;
  disableRecordingRules: boolean;
  exemplarTraceIdDestinations: ExemplarTraceIdDestination[] | undefined;
  exemplarsAvailable: boolean;
  hasIncrementalQuery: boolean;
  httpMethod: string;
  queryHttpMethod: string;
  queryTimeout: string;
  interval: string;
  languageProvider: PrometheusLanguageProviderInterface;
  lookupsDisabled: boolean;
  ruleMappings: RuleQueryMapping;
  seriesEndpoint: boolean;
  seriesLimit: number;
  type: string;
  url: string;
  withCredentials: boolean;
  defaultEditor?: QueryEditorMode;
  builderParseErrorHelp?: PromQueryBuilderParseErrorHelp;

  constructor(
    instanceSettings: DataSourceInstanceSettings<PromOptions>,
    private readonly templateSrv: TemplateSrv = getTemplateSrv(),
    languageProvider?: PrometheusLanguageProviderInterface
  ) {
    super(instanceSettings);

    // DATASOURCE CONFIGURATION PROPERTIES
    this.access = instanceSettings.access;
    this.basicAuth = instanceSettings.basicAuth;
    this.cache = new QueryCache({
      getTargetSignature: this.getPrometheusTargetSignature.bind(this),
      overlapString: instanceSettings.jsonData.incrementalQueryOverlapWindow ?? defaultPrometheusQueryOverlapWindow,
      applyInterpolation: this.interpolateString.bind(this),
    });
    this.cacheLevel = instanceSettings.jsonData.cacheLevel ?? PrometheusCacheLevel.Low;
    this.customQueryParameters = new URLSearchParams(instanceSettings.jsonData.customQueryParameters);
    this.datasourceConfigurationPrometheusFlavor = instanceSettings.jsonData.prometheusType;
    this.datasourceConfigurationPrometheusVersion = instanceSettings.jsonData.prometheusVersion;
    this.disableRecordingRules = instanceSettings.jsonData.disableRecordingRules ?? false;
    this.exemplarTraceIdDestinations = instanceSettings.jsonData.exemplarTraceIdDestinations;
    this.exemplarsAvailable = true;
    this.hasIncrementalQuery = instanceSettings.jsonData.incrementalQuerying ?? false;
    this.httpMethod = instanceSettings.jsonData.httpMethod || 'GET';
    this.queryHttpMethod = instanceSettings.jsonData.httpMethod || 'POST';
    this.queryTimeout = instanceSettings.jsonData.queryTimeout ?? '';
    this.interval = instanceSettings.jsonData.timeInterval || '15s';
    this.lookupsDisabled = instanceSettings.jsonData.disableMetricsLookup ?? false;
    this.ruleMappings = {};
    this.seriesEndpoint = instanceSettings.jsonData.seriesEndpoint ?? false;
    this.seriesLimit = instanceSettings.jsonData.seriesLimit ?? DEFAULT_SERIES_LIMIT;
    this.type = 'prometheus';
    this.url = instanceSettings.url!;
    this.withCredentials = Boolean(instanceSettings.withCredentials);
    this.defaultEditor = instanceSettings.jsonData.defaultEditor;
    this.builderParseErrorHelp = instanceSettings.jsonData.builderParseErrorHelp;

    // INHERITED PROPERTIES
    this.annotations = PrometheusAnnotationSupport(this);
    this.variables = new PrometheusVariableSupport(this, this.templateSrv);

    // LANGUAGE PROVIDER
    // This needs to be the last thing we initialize.
    this.languageProvider = languageProvider ?? new PrometheusLanguageProvider(this);
  }

  /**
   * Initializes the Prometheus datasource by loading recording rules and checking exemplar availability.
   *
   * This method performs two key initialization tasks: Loads recording rules from the
   * Prometheus API and checks if exemplars are available by testing the exemplars API endpoint.
   */
  init = async (): Promise<void> => {
    if (!this.disableRecordingRules) {
      this.loadRules();
    }
    this.exemplarsAvailable = await this.areExemplarsAvailable();
  };

  /**
   * Loads recording rules from the Prometheus API and extracts rule mappings.
   *
   * This method fetches rules from the `/api/v1/rules` endpoint and processes
   * them to create a mapping of rule names to their corresponding queries and labels.
   * The rules API is experimental, so errors are logged but not thrown.
   */
  private async loadRules(): Promise<void> {
    try {
      const params = {};
      const options = { showErrorAlert: false };
      const res = await this.metadataRequest('/api/v1/rules', params, options);
      const ruleGroups = res.data?.data?.groups;

      if (ruleGroups) {
        this.ruleMappings = extractRuleMappingFromGroups(ruleGroups);
      }
    } catch (err) {
      console.log('Rules API is experimental. Ignore next error.');
      console.error(err);
    }
  }

  /**
   * Checks if exemplars are available by testing the exemplars API endpoint.
   *
   * This method makes a test request to the `/api/v1/query_exemplars` endpoint to determine
   * if the Prometheus instance supports exemplars. The test uses a simple query with a
   * 30-minute time range. If the request succeeds with a 'success' status, exemplars
   * are considered available. Errors are caught and return false to avoid breaking
   * the datasource initialization.
   */
  private async areExemplarsAvailable(): Promise<boolean> {
    try {
      const params = {
        query: 'test',
        start: dateTime().subtract(30, 'minutes').valueOf().toString(),
        end: dateTime().valueOf().toString(),
      };
      const options = { showErrorAlert: false };
      const res = await this.metadataRequest('/api/v1/query_exemplars', params, options);

      return res.data.status === 'success';
    } catch (err) {
      return false;
    }
  }

  getQueryDisplayText(query: PromQuery) {
    return query.expr;
  }

  /**
   * Get target signature for query caching
   * @param request
   * @param query
   */
  getPrometheusTargetSignature(request: DataQueryRequest<PromQuery>, query: PromQuery) {
    const targExpr = this.interpolateString(query.expr);
    return `${targExpr}|${query.interval ?? request.interval}|${JSON.stringify(request.rangeRaw ?? '')}|${
      query.exemplar
    }`;
  }

  hasLabelsMatchAPISupport(): boolean {
    // users may choose the series endpoint as it has a POST method
    // while the label values is only GET
    if (this.seriesEndpoint) {
      return false;
    }

    return (
      // https://github.com/prometheus/prometheus/releases/tag/v2.24.0
      this._isDatasourceVersionGreaterOrEqualTo('2.24.0', PromApplication.Prometheus) ||
      // All versions of Mimir support matchers for labels API
      this._isDatasourceVersionGreaterOrEqualTo('2.0.0', PromApplication.Mimir) ||
      // https://github.com/cortexproject/cortex/discussions/4542
      this._isDatasourceVersionGreaterOrEqualTo('1.11.0', PromApplication.Cortex) ||
      // https://github.com/thanos-io/thanos/pull/3566
      //https://github.com/thanos-io/thanos/releases/tag/v0.18.0
      this._isDatasourceVersionGreaterOrEqualTo('0.18.0', PromApplication.Thanos)
    );
  }

  _isDatasourceVersionGreaterOrEqualTo(targetVersion: string, targetFlavor: PromApplication): boolean {
    // User hasn't configured flavor/version yet, default behavior is to support labels match api support
    if (!this.datasourceConfigurationPrometheusVersion || !this.datasourceConfigurationPrometheusFlavor) {
      return true;
    }

    if (targetFlavor !== this.datasourceConfigurationPrometheusFlavor) {
      return false;
    }

    return gte(this.datasourceConfigurationPrometheusVersion, targetVersion);
  }

  _addTracingHeaders(httpOptions: PromQueryRequest, options: DataQueryRequest<PromQuery>) {
    httpOptions.headers = {};
    if (this.access === 'proxy') {
      httpOptions.headers['X-Dashboard-UID'] = options.dashboardUID;
      httpOptions.headers['X-Panel-Id'] = options.panelId;
    }
  }

  directAccessError() {
    return throwError(
      () =>
        new Error(
          'Browser access mode in the Prometheus datasource is no longer available. Switch to server access mode.'
        )
    );
  }

  /**
   * Any request done from this data source should go through here as it contains some common processing for the
   * request. Any processing done here needs to be also copied on the backend as this goes through data source proxy
   * but not through the same code as alerting.
   */
  _request<T = unknown>(
    url: string,
    data: Record<string, string> | null,
    overrides: Partial<BackendSrvRequest> = {}
  ): Observable<FetchResponse<T>> {
    if (this.access === 'direct') {
      return this.directAccessError();
    }

    data = data || {};
    for (const [key, value] of this.customQueryParameters) {
      if (data[key] == null) {
        data[key] = value;
      }
    }

    let queryUrl = this.url + url;
    if (url.startsWith(`/api/datasources/uid/${this.uid}`)) {
      // This url is meant to be a replacement for the whole URL. Replace the entire URL
      queryUrl = url;
    }

    const options: BackendSrvRequest = defaults(overrides, {
      url: queryUrl,
      method: this.httpMethod,
      headers: {},
    });

    if (options.method === 'GET') {
      if (data && Object.keys(data).length) {
        options.url =
          options.url +
          (options.url.search(/\?/) >= 0 ? '&' : '?') +
          Object.entries(data)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
      }
    } else {
      if (!options.headers!['Content-Type']) {
        options.headers!['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      options.data = data;
    }

    if (this.basicAuth || this.withCredentials) {
      options.withCredentials = true;
    }

    if (this.basicAuth) {
      options.headers!.Authorization = this.basicAuth;
    }

    return getBackendSrv().fetch<T>(options);
  }

  async importFromAbstractQueries(abstractQueries: AbstractQuery[]): Promise<PromQuery[]> {
    return abstractQueries.map((abstractQuery) => importFromAbstractQuery(abstractQuery));
  }

  async exportToAbstractQueries(queries: PromQuery[]): Promise<AbstractQuery[]> {
    return queries.map((query) => exportToAbstractQuery(query));
  }

  // Use this for tab completion features, wont publish response to other components
  async metadataRequest<T = any>(url: string, params = {}, options?: Partial<BackendSrvRequest>) {
    // If URL includes endpoint that supports POST and GET method, try to use configured method. This might fail as POST is supported only in v2.10+.
    if (GET_AND_POST_METADATA_ENDPOINTS.some((endpoint) => url.includes(endpoint))) {
      try {
        return await lastValueFrom(
          this._request<T>(`/api/datasources/uid/${this.uid}/resources${url}`, params, {
            method: this.httpMethod,
            hideFromInspector: true,
            showErrorAlert: false,
            ...options,
          })
        );
      } catch (err) {
        // If status code of error is Method Not Allowed (405) and HTTP method is POST, retry with GET
        if (this.httpMethod === 'POST' && isFetchError(err) && (err.status === 405 || err.status === 400)) {
          console.warn(`Couldn't use configured POST HTTP method for this request. Trying to use GET method instead.`);
        } else {
          throw err;
        }
      }
    }

    return await lastValueFrom(
      this._request<T>(`/api/datasources/uid/${this.uid}/resources${url}`, params, {
        method: 'GET',
        hideFromInspector: true,
        ...options,
      })
    ); // toPromise until we change getTagValues, getLabelNames to Observable
  }

  interpolateQueryExpr(value: string | string[] = [], variable: QueryVariableModel | CustomVariableModel) {
    return interpolateQueryExpr(value, variable);
  }

  targetContainsTemplate(target: PromQuery) {
    return this.templateSrv.containsTemplate(target.expr);
  }

  shouldRunExemplarQuery(target: PromQuery, request: DataQueryRequest<PromQuery>): boolean {
    if (target.exemplar) {
      // We check all already processed targets and only create exemplar target for not used metric names
      const metricName = this.languageProvider.retrieveHistogramMetrics().find((m) => target.expr.includes(m));
      // Remove targets that weren't processed yet (in targets array they are after current target)
      const currentTargetIdx = request.targets.findIndex((t) => t.refId === target.refId);
      const targets = request.targets.slice(0, currentTargetIdx).filter((t) => !t.hide);

      if (!metricName || (metricName && !targets.some((t) => t.expr.includes(metricName)))) {
        return true;
      }
      return false;
    }
    return false;
  }

  processTargetV2(target: PromQuery, request: DataQueryRequest<PromQuery>) {
    const processedTargets: PromQuery[] = [];
    const processedTarget = {
      ...target,
      exemplar: this.shouldRunExemplarQuery(target, request),
      requestId: request.panelId + target.refId,
      // Align Prometheus range queries to UTC so every client uses the same cacheable step grid.
      utcOffsetSec: 0,
    };

    if (request.scopes) {
      processedTarget.scopes = (request.scopes ?? []).map((scope) => ({
        name: scope.metadata.name,
        ...scope.spec,
      }));
    }

    if (config.featureToggles.groupByVariable) {
      processedTarget.groupByKeys = request.groupByKeys;
    }

    if (target.instant && target.range) {
      // We have query type "Both" selected
      // We should send separate queries with different refId
      processedTargets.push(
        {
          ...processedTarget,
          refId: processedTarget.refId,
          instant: false,
        },
        {
          ...processedTarget,
          refId: processedTarget.refId + InstantQueryRefIdIndex,
          range: false,
          exemplar: false,
        }
      );
    } else {
      processedTargets.push(processedTarget);
    }

    return processedTargets;
  }

  query(request: DataQueryRequest<PromQuery>): Observable<DataQueryResponse> {
    if (this.access === 'direct') {
      return this.directAccessError();
    }

    const multiBatchTargets = this.getPrometheusMultiBatchTargets(request);
    if (multiBatchTargets.length > 0) {
      const preparedTargets = multiBatchTargets.map((target) =>
        this.preparePrometheusMultiBatchTarget(target, request)
      );
      const startTime = new Date();

      return this.queryPrometheusMultiBatchTargets(request, preparedTargets, startTime);
    }

    // Compact responses must retain their binary ownership through rendering. The incremental
    // cache stores and merges DataFrames, so legacy JSON queries are the only eligible inputs.
    const shouldUseIncrementalQuery =
      this.hasIncrementalQuery &&
      request.preferredQueryResultFormat !== 'compact-v1' &&
      !config.publicDashboardAccessToken &&
      !request.targets.some((target) => target.instant || target.expr?.includes('$__range'));

    let fullOrPartialRequest: DataQueryRequest<PromQuery> = request;
    let requestInfo: CacheRequestInfo<PromQuery> | undefined = undefined;

    if (shouldUseIncrementalQuery) {
      requestInfo = this.cache.requestInfo(request);
      fullOrPartialRequest = requestInfo.requests[0];
    }

    const targets = fullOrPartialRequest.targets.map((target) => this.processTargetV2(target, fullOrPartialRequest));
    const startTime = new Date();
    return super.query({ ...fullOrPartialRequest, targets: targets.flat() }).pipe(
      map((response) => {
        if (response.compactSeries) {
          if (request.app !== CoreApp.Explore) {
            return response;
          }

          return transformV2({ ...response, data: materializeCompactTimeSeries(response.compactSeries) }, request, {
            exemplarTraceIdDestinations: this.exemplarTraceIdDestinations,
          });
        }

        const amendedResponse = {
          ...response,
          data: this.cache.procFrames(request, requestInfo, response.data),
        };
        return transformV2(amendedResponse, request, {
          exemplarTraceIdDestinations: this.exemplarTraceIdDestinations,
        });
      }),
      tap((response: DataQueryResponse) => {
        trackQuery(response, request, startTime);
      })
    );
  }

  private queryPrometheusMultiBatchTargets(
    request: DataQueryRequest<PromQuery>,
    targets: PromQuery[],
    startTime: Date
  ): Observable<DataQueryResponse> {
    if (targets.length === 1) {
      const responseKey = `${request.requestId}-prometheus-multibatch`;
      const target = targets[0];
      return queryPrometheusMultiBatch(this.uid, request, target, {
        httpMethod: this.queryHttpMethod,
        customQueryParameters: this.customQueryParameters,
        minInterval: request.minInterval ?? this.interval,
        queryTimeout: this.queryTimeout,
      }).pipe(
        map((response) => {
          const keyedResponse = { ...response, key: responseKey };
          if (keyedResponse.compactSeries) {
            return keyedResponse;
          }
          return transformV2(keyedResponse, request, {
            exemplarTraceIdDestinations: this.exemplarTraceIdDestinations,
          });
        }),
        tap((response) => {
          if (response.state === LoadingState.Done) {
            trackQuery(response, request, startTime);
          }
        })
      );
    }

    return new Observable<DataQueryResponse>((subscriber) => {
      const latestDataByTarget = new Map<string, DataFrame[]>();
      const latestCompactSeriesByTarget = new Map<string, CompactTimeSeriesData>();
      const errorsByTarget = new Map<string, DataQueryError>();
      const completedTargets = new Set<string>();
      const targetKeys = targets.map((target, index) => target.refId ?? String(index));
      const responseKey = `${request.requestId}-prometheus-multibatch`;
      let pendingResponse: DataQueryResponse | undefined;
      let publishScheduled = false;
      let cancelScheduledPublish: (() => void) | undefined;
      let completeAfterPublish = false;

      const publishCombinedResponse = (response: DataQueryResponse) => {
        const allTargetsDone = completedTargets.size === targets.length;
        const errors = targetKeys.flatMap((key) => {
          const error = errorsByTarget.get(key);
          return error ? [error] : [];
        });
        const hasFullTarget = targetKeys.some(
          (key) => latestDataByTarget.has(key) && !latestCompactSeriesByTarget.has(key)
        );
        const combinedCompactSeries = hasFullTarget
          ? undefined
          : combineCompactTimeSeries(targetKeys.map((key) => latestCompactSeriesByTarget.get(key)));
        const rawCombinedResponse: DataQueryResponse = {
          ...response,
          compactSeries: combinedCompactSeries,
          data: targetKeys.flatMap((key) => {
            const compactSeries = latestCompactSeriesByTarget.get(key);
            return hasFullTarget && compactSeries
              ? materializeCompactTimeSeries(compactSeries)
              : (latestDataByTarget.get(key) ?? []);
          }),
          error: errors[0],
          errors: errors.length > 0 ? errors : undefined,
          key: responseKey,
          state: allTargetsDone ? LoadingState.Done : LoadingState.Streaming,
        };
        const combinedResponse = combinedCompactSeries
          ? rawCombinedResponse
          : transformV2(rawCombinedResponse, request, {
              exemplarTraceIdDestinations: this.exemplarTraceIdDestinations,
            });

        if (combinedResponse.state === LoadingState.Done) {
          trackQuery(combinedResponse, request, startTime);
        }
        subscriber.next(combinedResponse);
      };

      const flushCombinedResponse = () => {
        publishScheduled = false;
        cancelScheduledPublish = undefined;
        const response = pendingResponse;
        pendingResponse = undefined;
        if (response) {
          publishCombinedResponse(response);
        }
        if (completeAfterPublish) {
          subscriber.complete();
        }
      };

      const scheduleCombinedResponse = (response: DataQueryResponse) => {
        pendingResponse = response;
        if (publishScheduled) {
          return;
        }
        publishScheduled = true;
        const timer = setTimeout(flushCombinedResponse, MULTI_TARGET_BATCH_PUBLISH_DELAY_MS);
        cancelScheduledPublish = () => clearTimeout(timer);
      };

      const completeWhenPublished = () => {
        if (completedTargets.size !== targets.length) {
          return;
        }
        if (pendingResponse || publishScheduled) {
          completeAfterPublish = true;
        } else {
          subscriber.complete();
        }
      };

      const emitCombinedResponse = (targetKey: string, response: DataQueryResponse) => {
        latestDataByTarget.set(targetKey, response.data);
        if (response.compactSeries) {
          latestCompactSeriesByTarget.set(targetKey, response.compactSeries);
        } else {
          latestCompactSeriesByTarget.delete(targetKey);
        }
        const targetError = response.error ?? response.errors?.[0];
        if (targetError) {
          errorsByTarget.set(targetKey, targetError);
        } else {
          errorsByTarget.delete(targetKey);
        }
        if (response.state === LoadingState.Done) {
          completedTargets.add(targetKey);
        }

        scheduleCombinedResponse(response);
      };

      const subscriptions = targets.map((target, index) =>
        queryPrometheusMultiBatch(this.uid, request, target, {
          httpMethod: this.queryHttpMethod,
          customQueryParameters: this.customQueryParameters,
          minInterval: request.minInterval ?? this.interval,
          queryTimeout: this.queryTimeout,
        }).subscribe({
          complete: () => {
            completedTargets.add(targetKeys[index]);
            completeWhenPublished();
          },
          error: (error) => {
            emitCombinedResponse(targetKeys[index], {
              data: [],
              error: this.toDataQueryError(error, target.refId),
              state: LoadingState.Done,
            });
            completeWhenPublished();
          },
          next: (response) => emitCombinedResponse(targetKeys[index], response),
        })
      );

      return () => {
        cancelScheduledPublish?.();
        pendingResponse = undefined;
        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }
      };
    });
  }

  private getPrometheusMultiBatchTargets(request: DataQueryRequest<PromQuery>): PromQuery[] {
    if (
      !config.featureToggles.prometheusMultiBatchStreaming ||
      config.publicDashboardAccessToken ||
      request.app === CoreApp.Explore
    ) {
      return [];
    }

    const visibleTargets = request.targets.filter((target) => this.filterQuery(target));
    if (visibleTargets.length === 0) {
      return [];
    }

    if ((request.scopes?.length ?? 0) > 0 || (request.groupByKeys?.length ?? 0) > 0) {
      return [];
    }

    if (request.queryCachingTTL || request.stepSize || this.hasTemplateVariable(request.minInterval)) {
      return [];
    }

    if (visibleTargets.some((target) => !this.isPrometheusMultiBatchTarget(target))) {
      return [];
    }

    if (visibleTargets.some((target) => this.shouldUseBackendQueryPathForMultiBatch(target, request))) {
      return [];
    }

    return visibleTargets;
  }

  private isPrometheusMultiBatchTarget(target: PromQuery): boolean {
    const responseFormat = target.format || 'time_series';
    if (target.instant || target.range === false || target.exemplar || responseFormat !== 'time_series') {
      return false;
    }

    const datasourceUid = typeof target.datasource === 'string' ? target.datasource : target.datasource?.uid;
    if (datasourceUid && datasourceUid !== this.uid) {
      return false;
    }

    return true;
  }

  private shouldUseBackendQueryPathForMultiBatch(target: PromQuery, request: DataQueryRequest<PromQuery>): boolean {
    if ((target.scopes?.length ?? 0) > 0 || (target.groupByKeys?.length ?? 0) > 0) {
      return true;
    }

    return (
      this.hasTemplateVariable(target.interval) ||
      this.hasTemplateVariable(target.stepSize) ||
      this.hasUnsupportedPrometheusMultiBatchExpression(target.expr)
    );
  }

  private preparePrometheusMultiBatchTarget(target: PromQuery, request: DataQueryRequest<PromQuery>): PromQuery {
    const processedTarget = this.processTargetV2(target, request)[0];
    return this.applyTemplateVariables(processedTarget, request.scopedVars, request.filters);
  }

  private hasTemplateVariable(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.includes('$');
  }

  private hasUnsupportedPrometheusMultiBatchExpression(expr: string | undefined): boolean {
    return typeof expr === 'string' && /\b(?:head_[a-zA-Z0-9_]+|median_[a-zA-Z0-9_]+)\s*\(/.test(expr);
  }

  private toDataQueryError(error: unknown, refId: string | undefined): DataQueryError {
    if (isFetchError(error)) {
      return {
        data: error.data,
        message: error.message,
        refId,
        status: error.status,
        statusText: error.statusText,
      };
    }

    if (error instanceof Error) {
      return { message: error.message, refId };
    }

    return { message: String(error), refId };
  }

  protected shouldRequestCompactQueryResponse(request: DataQueryRequest<PromQuery>, queries: PromQuery[]): boolean {
    return (
      (request.app === CoreApp.Dashboard || request.app === CoreApp.Explore) &&
      (request.panelPluginId === 'timeseries' || request.panelPluginId === 'barchart') &&
      !config.publicDashboardAccessToken &&
      queries.every((query) => query.datasource?.type === this.type && isCompactTimeSeriesRangeQuery(query))
    );
  }

  metricFindQuery(query: string, options?: LegacyMetricFindQueryOptions) {
    if (!query) {
      return Promise.resolve([]);
    }

    const timeRange = options?.range ?? getDefaultTimeRange();

    const scopedVars = {
      ...this.getIntervalVars(),
      ...this.getRangeScopedVars(timeRange),
    };
    const interpolated = this.templateSrv.replace(query, scopedVars, this.interpolateQueryExpr);
    const metricFindQuery = new PrometheusMetricFindQuery(this, interpolated);
    return metricFindQuery.process(timeRange);
  }

  getIntervalVars() {
    return {
      __interval: { text: this.interval, value: this.interval },
      __interval_ms: { text: rangeUtil.intervalToMs(this.interval), value: rangeUtil.intervalToMs(this.interval) },
    };
  }

  getRangeScopedVars(range: TimeRange) {
    const msRange = range.to.diff(range.from);
    const sRange = Math.round(msRange / 1000);
    return {
      __range_ms: { text: msRange, value: msRange },
      __range_s: { text: sRange, value: sRange },
      __range: { text: sRange + 's', value: sRange + 's' },
    };
  }

  // By implementing getTagKeys and getTagValues we add ad-hoc filters functionality
  // this is used to get label keys, a.k.a label names
  // it is used in metric_find_query.ts
  // and in Tempo here grafana/public/app/plugins/datasource/tempo/QueryEditor/ServiceGraphSection.tsx
  async getTagKeys(options: DataSourceGetTagKeysOptions<PromQuery>): Promise<MetricFindValue[]> {
    if (!options.timeRange) {
      options.timeRange = getDefaultTimeRange();
    }

    if ((options?.scopes?.length ?? 0) > 0) {
      const suggestions = await this.languageProvider.fetchSuggestions(
        options.timeRange,
        options.queries,
        options.scopes,
        options.filters
      );

      // filter out already used labels and empty labels
      return suggestions
        .filter((labelName) => !!labelName && !options.filters.find((filter) => filter.key === labelName))
        .map((k) => ({ value: k, text: k }));
    }

    const match = extractResourceMatcher(options.queries ?? [], options.filters);

    let labelKeys: string[] = await this.languageProvider.queryLabelKeys(options.timeRange, match);

    // filter out already used labels
    return labelKeys
      .filter((labelName) => !options.filters.find((filter) => filter.key === labelName))
      .map((k) => ({ value: k, text: k }));
  }

  // By implementing getTagKeys and getTagValues we add ad-hoc filters functionality
  async getTagValues(options: DataSourceGetTagValuesOptions<PromQuery>): Promise<MetricFindValue[]> {
    if (!options.timeRange) {
      options.timeRange = getDefaultTimeRange();
    }

    const requestId = `[${this.uid}][${options.key}]`;
    if ((options?.scopes?.length ?? 0) > 0) {
      return (
        await this.languageProvider.fetchSuggestions(
          options.timeRange,
          options.queries,
          options.scopes,
          options.filters,
          options.key,
          undefined,
          requestId
        )
      ).map((v) => ({ value: v, text: v }));
    }

    const match = extractResourceMatcher(options.queries ?? [], options.filters);

    return (await this.languageProvider.queryLabelValues(options.timeRange, options.key, match)).map((v) => ({
      value: v,
      text: v,
    }));
  }

  interpolateVariablesInQueries(
    queries: PromQuery[],
    scopedVars: ScopedVars,
    filters?: AdHocVariableFilter[]
  ): PromQuery[] {
    let expandedQueries = queries;
    if (queries && queries.length) {
      expandedQueries = queries.map((query) => {
        const interpolatedQuery = this.templateSrv.replace(
          query.expr,
          scopedVars,
          this.interpolateExploreMetrics(query.fromExploreMetrics)
        );
        const replacedInterpolatedQuery = targetHasScopes(query)
          ? interpolatedQuery
          : this.templateSrv.replace(
              this.enhanceExprWithAdHocFilters(filters, interpolatedQuery),
              scopedVars,
              this.interpolateQueryExpr
            );

        const expandedQuery = {
          ...query,
          ...(query.scopes && query.scopes.length > 0 ? { adhocFilters: this.generateScopeFilters(filters) } : {}),
          datasource: this.getRef(),
          expr: replacedInterpolatedQuery,
          interval: this.templateSrv.replace(query.interval, scopedVars),
        };

        return expandedQuery;
      });
    }
    return expandedQueries;
  }

  getQueryHints(query: PromQuery, result: unknown[]) {
    return getQueryHints(query.expr ?? '', result, this);
  }

  modifyQuery(query: PromQuery, action: QueryFixAction): PromQuery {
    let expression = query.expr ?? '';
    switch (action.type) {
      case 'ADD_FILTER': {
        const { key, value } = action.options ?? {};
        if (key && value) {
          expression = addLabelToQuery(expression, key, value);
        }

        break;
      }
      case 'ADD_FILTER_OUT': {
        const { key, value } = action.options ?? {};
        if (key && value) {
          expression = addLabelToQuery(expression, key, value, '!=');
        }
        break;
      }
      case 'ADD_HISTOGRAM_QUANTILE': {
        expression = `histogram_quantile(0.95, sum(rate(${expression}[$__rate_interval])) by (le))`;
        break;
      }
      case 'ADD_HISTOGRAM_AVG': {
        expression = `histogram_avg(rate(${expression}[$__rate_interval]))`;
        break;
      }
      case 'ADD_HISTOGRAM_FRACTION': {
        expression = `histogram_fraction(0,0.2,rate(${expression}[$__rate_interval]))`;
        break;
      }
      case 'ADD_HISTOGRAM_COUNT': {
        expression = `histogram_count(rate(${expression}[$__rate_interval]))`;
        break;
      }
      case 'ADD_HISTOGRAM_SUM': {
        expression = `histogram_sum(rate(${expression}[$__rate_interval]))`;
        break;
      }
      case 'ADD_HISTOGRAM_STDDEV': {
        expression = `histogram_stddev(rate(${expression}[$__rate_interval]))`;
        break;
      }
      case 'ADD_HISTOGRAM_STDVAR': {
        expression = `histogram_stdvar(rate(${expression}[$__rate_interval]))`;
        break;
      }
      case 'ADD_RATE': {
        expression = `rate(${expression}[$__rate_interval])`;
        break;
      }
      case 'ADD_SUM': {
        expression = `sum(${expression.trim()}) by ($1)`;
        break;
      }
      case 'EXPAND_RULES': {
        if (action.options) {
          expression = expandRecordingRules(expression, action.options as any);
        }
        break;
      }
      default:
        break;
    }
    return { ...query, expr: expression };
  }

  /**
   * Returns the adjusted "snapped" interval parameters
   */
  getAdjustedInterval(timeRange: TimeRange): { start: string; end: string } {
    return getRangeSnapInterval(this.cacheLevel, timeRange);
  }

  /**
   * This will return a time range that always includes the users current time range,
   * and then a little extra padding to round up/down to the nearest nth minute,
   * defined by the result of the getCacheDurationInMinutes.
   *
   * For longer cache durations, and shorter query durations,
   * the window we're calculating might be much bigger then the user's current window,
   * resulting in us returning labels/values that might not be applicable for the given window,
   * this is a necessary trade-off if we want to cache larger durations
   */
  getTimeRangeParams(timeRange: TimeRange): { start: string; end: string } {
    return {
      start: getPrometheusTime(timeRange.from, false).toString(),
      end: getPrometheusTime(timeRange.to, true).toString(),
    };
  }

  /**
   * This converts the adhocVariableFilter array and converts it to scopeFilter array
   * @param filters
   */
  generateScopeFilters(filters?: AdHocVariableFilter[]): ScopeSpecFilter[] {
    if (!filters) {
      return [];
    }

    return filters.map((f) => ({
      key: f.key,
      operator: scopeFilterOperatorMap[f.operator],
      value: this.templateSrv.replace(f.value, {}, this.interpolateQueryExpr),
      values: f.values?.map((v) => this.templateSrv.replace(v, {}, this.interpolateQueryExpr)),
    }));
  }

  enhanceExprWithAdHocFilters(filters: AdHocVariableFilter[] | undefined, expr: string) {
    if (!filters || filters.length === 0) {
      return expr;
    }

    const finalQuery = filters.reduce((acc, filter) => {
      const { key, operator } = filter;
      let { value } = filter;
      if (operator === '=~' || operator === '!~') {
        value = prometheusRegularEscape(value);
      }
      return addLabelToQuery(acc, key, value, operator);
    }, expr);
    return finalQuery;
  }

  // Used when running queries through backend
  filterQuery(query: PromQuery): boolean {
    if (query.hide || !query.expr) {
      return false;
    }
    return true;
  }

  // Used when running queries through backend
  applyTemplateVariables(target: PromQuery, scopedVars: ScopedVars, filters?: AdHocVariableFilter[]) {
    const variables = { ...scopedVars };

    // We want to interpolate these variables on backend.
    // The pre-calculated values are replaced withe the variable strings.
    variables.__interval = {
      value: '$__interval',
    };
    variables.__interval_ms = {
      value: '$__interval_ms',
    };

    // interpolate expression

    // We need a first replace to evaluate variables before applying adhoc filters
    // This is required for an expression like `metric > $VAR` where $VAR is a float to which we must not add adhoc filters
    const expr = this.templateSrv.replace(
      target.expr,
      variables,
      this.interpolateExploreMetrics(target.fromExploreMetrics)
    );

    // Apply ad-hoc filters
    // When ad-hoc filters are applied, we replace again the variables in case the ad-hoc filters also reference a variable
    const exprWithAdhoc = targetHasScopes(target)
      ? expr
      : this.templateSrv.replace(this.enhanceExprWithAdHocFilters(filters, expr), variables, this.interpolateQueryExpr);

    return {
      ...target,
      ...(targetHasScopes(target) ? { adhocFilters: this.generateScopeFilters(filters) } : {}),
      expr: exprWithAdhoc,
      interval: this.templateSrv.replace(target.interval, variables),
      legendFormat: this.templateSrv.replace(target.legendFormat, variables),
    };
  }

  getVariables(): string[] {
    return this.templateSrv.getVariables().map((v) => `$${v.name}`);
  }

  interpolateString(string: string, scopedVars?: ScopedVars) {
    return this.templateSrv.replace(string, scopedVars, this.interpolateQueryExpr);
  }

  interpolateExploreMetrics(fromExploreMetrics?: boolean) {
    return (value: string | string[] = [], variable: QueryVariableModel | CustomVariableModel) => {
      if (typeof value === 'string' && fromExploreMetrics) {
        if (variable.name === 'filters') {
          return wrapUtf8Filters(value);
        }
        if (variable.name === 'groupby') {
          return utf8Support(value);
        }
      }
      return this.interpolateQueryExpr(value, variable);
    };
  }

  getDefaultQuery(app: CoreApp): PromQuery {
    const defaults = {
      refId: 'A',
      expr: '',
      range: true,
      instant: false,
    };

    if (app === CoreApp.UnifiedAlerting) {
      return {
        ...defaults,
        instant: true,
        range: false,
      };
    }

    if (app === CoreApp.Explore) {
      return {
        ...defaults,
        instant: true,
        range: true,
      };
    }

    return defaults;
  }
}

function isCompactTimeSeriesRangeQuery(query: PromQuery): boolean {
  const { instant, range, exemplar, format } = query;
  const responseFormat = format || 'time_series';

  return instant !== true && range !== false && exemplar !== true && responseFormat === 'time_series';
}

export function materializeCompactTimeSeries(compact: CompactTimeSeriesData): DataFrame[] {
  const view = new DataView(compact.buffer);
  const bytes = new Uint8Array(compact.buffer);
  return compact.series.map((series) => {
    const axis = compact.axes[series.axisId];
    const times = new Array<number>(axis.count);
    const values = new Array<number | null>(axis.count);
    let packedIndex = 0;
    for (let index = 0; index < axis.count; index++) {
      times[index] = axis.start + axis.step * index;
      const present =
        series.presenceByteLength === 0 || (bytes[series.presenceByteOffset + (index >> 3)] & (1 << (index & 7))) !== 0;
      if (!present) {
        values[index] = null;
        continue;
      }
      values[index] = view.getFloat64(series.valuesByteOffset + packedIndex * Float64Array.BYTES_PER_ELEMENT, true);
      packedIndex++;
    }
    return {
      name: series.frameName,
      refId: series.refId,
      meta: series.meta,
      length: axis.count,
      fields: [
        { name: 'Time', type: FieldType.time, config: { interval: axis.step }, values: times },
        {
          name: series.valueName,
          type: FieldType.number,
          config: series.displayNameFromDS ? { displayNameFromDS: series.displayNameFromDS } : {},
          labels: compact.metadata.materializeLabels(series),
          values,
        },
      ],
    };
  });
}

export function combineCompactTimeSeries(
  compactSeriesList: Array<CompactTimeSeriesData | undefined>
): CompactTimeSeriesData | undefined {
  const compactSeries = compactSeriesList.filter((series): series is CompactTimeSeriesData => Boolean(series));
  if (compactSeries.length === 0) {
    return undefined;
  }
  if (compactSeries.length === 1) {
    return compactSeries[0];
  }

  const bufferOffsets: number[] = [];
  let combinedByteLength = 0;
  for (const series of compactSeries) {
    combinedByteLength = alignToEightBytes(combinedByteLength);
    bufferOffsets.push(combinedByteLength);
    combinedByteLength += series.buffer.byteLength;
  }

  const combinedBuffer = new ArrayBuffer(combinedByteLength);
  const combinedBytes = new Uint8Array(combinedBuffer);
  const combinedAxes: CompactTimeSeriesAxis[] = [];
  const combinedSeries: CompactTimeSeriesSeries[] = [];
  const combinedNotices: CompactTimeSeriesNotice[] = [];
  const sourceBySeries = new Map<
    CompactTimeSeriesSeries,
    { metadata: CompactTimeSeriesMetadata; series: CompactTimeSeriesSeries }
  >();
  let axisOffset = 0;
  let resultCount = 0;
  let stringCount = 0;
  let stringBytes = 0;

  compactSeries.forEach((source, index) => {
    const bufferOffset = bufferOffsets[index];
    combinedBytes.set(new Uint8Array(source.buffer), bufferOffset);
    combinedAxes.push(...source.axes);
    resultCount += source.decodeStats.resultCount;
    stringCount += source.decodeStats.stringCount;
    stringBytes += source.decodeStats.stringBytes;

    for (const sourceSeries of source.series) {
      const shiftedSeries: CompactTimeSeriesSeries = {
        ...sourceSeries,
        axisId: sourceSeries.axisId + axisOffset,
        labelRecordsOffset: sourceSeries.labelRecordsOffset + bufferOffset,
        presenceByteOffset: sourceSeries.presenceByteOffset + bufferOffset,
        valuesByteOffset: sourceSeries.valuesByteOffset + bufferOffset,
      };
      combinedSeries.push(shiftedSeries);
      sourceBySeries.set(shiftedSeries, { metadata: source.metadata, series: sourceSeries });
    }

    if (source.notices) {
      combinedNotices.push(...source.notices);
    }
    axisOffset += source.axes.length;
  });

  const metadata: CompactTimeSeriesMetadata = {
    getLabel: (series, name) => {
      const source = sourceBySeries.get(series);
      return source?.metadata.getLabel(source.series, name);
    },
    forEachLabel: (series, callback) => {
      const source = sourceBySeries.get(series);
      source?.metadata.forEachLabel(source.series, callback);
    },
    materializeLabels: (series, additional?: Labels) => {
      const source = sourceBySeries.get(series);
      return source?.metadata.materializeLabels(source.series, additional);
    },
  };

  return {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer: combinedBuffer,
    axes: combinedAxes,
    series: combinedSeries,
    metadata,
    notices: combinedNotices.length > 0 ? combinedNotices : undefined,
    decodeStats: {
      responseBytes: combinedBuffer.byteLength,
      axisCount: combinedAxes.length,
      resultCount,
      stringCount,
      stringBytes,
      seriesCount: combinedSeries.length,
    },
  };
}

function alignToEightBytes(value: number): number {
  return (value + 7) & ~7;
}

function targetHasScopes(target: PromQuery): boolean {
  return !!(target.scopes && target.scopes.length > 0);
}

export function extractRuleMappingFromGroups(groups: RawRecordingRules[]): RuleQueryMapping {
  return groups.reduce<RuleQueryMapping>(
    (mapping, group) =>
      group.rules
        .filter((rule) => rule.type === 'recording')
        .reduce((acc, rule) => {
          // retrieve existing record
          const existingRule = acc[rule.name] ?? [];
          // push a new query with labels
          existingRule.push({
            query: rule.query,
            labels: rule.labels,
          });
          acc[rule.name] = existingRule;
          return acc;
        }, mapping),
    {}
  );
}

/**
 * It creates a matcher string for resource calls
 * @param queries
 * @param adhocFilters
 *
 * @example
 * queries<PromQuery>=[{expr:`metricName{label="value"}`}]
 * adhocFilters={key:"instance", operator:"=", value:"localhost"}
 * returns {__name__=~"metricName", instance="localhost"}
 */
export const extractResourceMatcher = (
  queries: PromQuery[],
  adhocFilters: AdHocVariableFilter[]
): string | undefined => {
  // Extract metric names from queries we have already
  const metricMatch = populateMatchParamsFromQueries(queries);
  const labelFilters: QueryBuilderLabelFilter[] = adhocFilters.map((f) => ({
    label: f.key,
    value: f.value,
    op: f.operator,
  }));
  // Extract label filters from the filters we have already
  const labelsMatch = renderLabelsWithoutBrackets(labelFilters);

  if (metricMatch.length === 0 && labelsMatch.length === 0) {
    return undefined;
  }

  // Create a matcher using metric names and label filters
  return `{${[...metricMatch, ...labelsMatch].join(',')}}`;
};
