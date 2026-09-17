/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/react';
import {
  EuiAccordion,
  EuiBadge,
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiHorizontalRule,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
  useGeneratedHtmlId,
} from '@elastic/eui';
import { KbnDangerCallout, KbnWarningCallout } from '@kbn/ui-callout';
import { i18n } from '@kbn/i18n';
import { getESQLResults } from '@kbn/esql-utils';
import { buildEsQuery, type Filter } from '@kbn/es-query';
import { getEsQueryConfig, getTime } from '@kbn/data-plugin/public';
import dateMath from '@kbn/datemath';
import type { ChartSectionProps } from '@kbn/unified-histogram/types';
import type { AiopsAppContextValue } from '@kbn/aiops-plugin/public/hooks/use_aiops_app_context';
import { useDiscoverServices } from '../../../../../hooks/use_discover_services';
import {
  type ChangePoint,
  type ErrorOutlier,
  type InsightsState,
  type PatternChange,
  type PatternChangeKind,
  type PatternErrorOutlier,
  ACCORDION_STORAGE_KEY,
  BADGE_COLOR_BY_KIND,
  buildChangePointQuery,
  buildCohortBreakdownQuery,
  buildCrossPeriodQuery,
  buildErrorOutlierQuery,
  buildErrorRateChangePointQuery,
  buildMeanCountQuery,
  buildOutliersQuery,
  buildPatternErrorOutlierQuery,
  buildTopPatternsQuery,
  COHORT_FIELD_LABELS,
  COHORT_FIELDS,
  computeErrorOutliers,
  computePatternErrorOutliers,
  DEFAULT_OPEN_SECTIONS,
  diffPatterns,
  extendTimeRangeForChangePoint,
  formatBucketTime,
  formatChangePointType,
  getBadgeLabelByKind,
  resolvePreviousPeriodTimeRange,
  truncate,
} from './logs_insights_utils';

const ERROR_LEVEL_VALUES = ['error', 'ERROR', 'critical', 'CRITICAL'] as const;
const MAX_DISPLAYED_OUTLIERS = 8;
/** Duration of a single CHANGE_POINT bucket in milliseconds (30 minutes). */
const SPIKE_BUCKET_DURATION_MS = 30 * 60 * 1000;

const listCss = css({
  margin: 0,
  paddingLeft: '1em',
});

const mutedTextCss = css({
  opacity: 0.7,
});

interface LogRateAnalysisFlyoutProps {
  fetchParams: ChartSectionProps['fetchParams'];
  services: ChartSectionProps['services'];
  onClose: () => void;
}

const LogRateAnalysisFlyout = ({ fetchParams, services, onClose }: LogRateAnalysisFlyoutProps) => {
  const discoverServices = useDiscoverServices();
  const aiopsService = discoverServices.aiops;
  const flyoutTitleId = useGeneratedHtmlId();

  const { dataView, filters: existingFilters, timeRange } = fetchParams;

  const periodResolution = useMemo(
    () => resolvePreviousPeriodTimeRange(timeRange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // timeRange is an object that changes reference on every render; listing the primitive
    // from/to strings avoids spurious re-runs while still reacting to actual time changes.
    [timeRange.from, timeRange.to]
  );

  // Use the extended time range (covering both periods) for log rate analysis.
  const analysisTimeRange = periodResolution?.extendedTimeRange ?? timeRange;
  const momentTimeRange = useMemo(() => {
    const min = dateMath.parse(analysisTimeRange.from);
    const max = dateMath.parse(analysisTimeRange.to, { roundUp: true });
    return min && max ? { min, max } : undefined;
  }, [analysisTimeRange.from, analysisTimeRange.to]);

  // Pre-seed the deviation window at the current period boundary so the
  // analysis immediately compares the two halves of the extended window.
  const initialAnalysisStart = periodResolution
    ? new Date(periodResolution.currentStartIso).getTime()
    : undefined;

  // Build the ES query for the analysis (filters only — time handled via timeRange prop).
  const esSearchQuery = useMemo(() => {
    if (!existingFilters?.length) return undefined;
    try {
      return buildEsQuery(undefined, [], existingFilters, getEsQueryConfig(services.uiSettings));
    } catch {
      return undefined;
    }
  }, [existingFilters, services.uiSettings]);

  if (!aiopsService || !dataView) return null;

  const { LogRateAnalysisContentComponent } = aiopsService;

  return (
    <EuiFlyout aria-labelledby={flyoutTitleId} onClose={onClose} size="l" ownFocus>
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="m">
          <h2 id={flyoutTitleId}>
            {i18n.translate('discover.logsInsights.logRateAnalysis.flyoutTitle', {
              defaultMessage: 'Log rate analysis',
            })}
          </h2>
        </EuiTitle>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        <LogRateAnalysisContentComponent
          dataView={dataView}
          appContextValue={
            // discoverServices is structurally compatible with AiopsAppContextValue but TypeScript
            // cannot verify this across package boundaries. The cast is safe: AiopsAppContextValue
            // only reads properties that Discover's service bag provides.
            // Same pattern used by Discover's log pattern analysis table.
            { embeddingOrigin: 'discover', ...discoverServices } as unknown as AiopsAppContextValue
          }
          timeRange={momentTimeRange}
          esSearchQuery={esSearchQuery}
          initialAnalysisStart={initialAnalysisStart}
        />
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};

export const LogsInsightsPanel = (props: ChartSectionProps) => {
  const { fetchParams, renderToggleActions, services, isComponentVisible } = props;
  const indexPattern = fetchParams.dataView?.getIndexPattern();

  const discoverServices = useDiscoverServices();
  const aiopsService = discoverServices.aiops;

  const [state, setState] = useState<InsightsState>({
    loading: false,
    changePoints: [],
    errorChangePoints: [],
    patterns: [],
    outliers: [],
    patternChanges: [],
    hasPreviousData: false,
    errorOutliers: [],
    patternErrorOutliers: [],
    meanCount: 0,
  });

  const [flyoutOpen, setFlyoutOpen] = useState(false);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const stored: unknown = services.storage.get(ACCORDION_STORAGE_KEY);
    return stored && typeof stored === 'object'
      ? { ...DEFAULT_OPEN_SECTIONS, ...(stored as Record<string, boolean>) }
      : DEFAULT_OPEN_SECTIONS;
  });
  // Delay forceState until after mount to avoid CSS transition flash on first render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const toggleSection = useCallback(
    (id: string) => {
      setOpenSections((prev) => {
        const next = { ...prev, [id]: !prev[id] };
        services.storage.set(ACCORDION_STORAGE_KEY, next);
        return next;
      });
    },
    [services.storage]
  );

  const [cohortBreakdowns, setCohortBreakdowns] = useState<
    Array<{ field: string; entries: Array<{ value: string; count: number }> }>
  >([]);
  const [cohortBreakdownLoading, setCohortBreakdownLoading] = useState(false);
  const cohortBreakdownAbortRef = useRef<AbortController | null>(null);

  // Abort any in-flight cohort breakdown when the component unmounts.
  useEffect(() => {
    return () => {
      cohortBreakdownAbortRef.current?.abort();
    };
  }, []);

  const applyErrorLevelFilter = useCallback(() => {
    const filter: Filter = {
      meta: {
        alias: i18n.translate('discover.logsInsights.errorLevelFilterAlias', {
          defaultMessage: 'Error / Critical logs',
        }),
        disabled: false,
        index: fetchParams.dataView?.id,
      },
      query: {
        terms: { 'log.level': ERROR_LEVEL_VALUES },
      },
    };
    discoverServices.data.query.filterManager.addFilters(filter);
  }, [discoverServices.data.query.filterManager, fetchParams.dataView?.id]);

  const applyMessageFilter = useCallback(
    (category: string) => {
      // CATEGORIZE with output_format:"tokens" returns space-separated analyzed
      // terms (e.g. "failed connect port") with numeric/high-cardinality values
      // already stripped. A match query with operator:and requires all of those
      // stable terms to be present — the same approach used by log pattern analysis.
      const filter: Filter = {
        meta: {
          alias: i18n.translate('discover.logsInsights.filterAlias', {
            defaultMessage: 'Log pattern',
          }),
          disabled: false,
          index: fetchParams.dataView?.id,
        },
        query: {
          bool: {
            should: [
              {
                match: {
                  message: {
                    query: category,
                    auto_generate_synonyms_phrase_query: false,
                    fuzziness: 0,
                    operator: 'and',
                  },
                },
              },
            ],
          },
        },
      };
      discoverServices.data.query.filterManager.addFilters(filter);
    },
    [discoverServices.data.query.filterManager, fetchParams.dataView?.id]
  );

  const applyCohortFilter = useCallback(
    (field: string, value: string) => {
      const cohortFilter: Filter = {
        meta: {
          alias: null,
          disabled: false,
          index: fetchParams.dataView?.id,
        },
        query: { term: { [field]: value } },
      };
      discoverServices.data.query.filterManager.addFilters(cohortFilter);
    },
    [discoverServices.data.query.filterManager, fetchParams.dataView?.id]
  );

  const applyOutlierFilter = useCallback(
    (field: string, value: string) => {
      const termFilter: Filter = {
        meta: { alias: null, disabled: false, index: fetchParams.dataView?.id },
        query: { term: { [field]: value } },
      };
      const errorLevelFilter: Filter = {
        meta: {
          alias: i18n.translate('discover.logsInsights.errorLevelFilterAlias', {
            defaultMessage: 'Error / Critical logs',
          }),
          disabled: false,
          index: fetchParams.dataView?.id,
        },
        query: { terms: { 'log.level': ERROR_LEVEL_VALUES } },
      };
      discoverServices.data.query.filterManager.addFilters([termFilter, errorLevelFilter]);
    },
    [discoverServices.data.query.filterManager, fetchParams.dataView?.id]
  );

  const loadCohortBreakdown = useCallback(() => {
    const currentChangePoints = state.changePoints;
    if (!indexPattern || currentChangePoints.length === 0) return;

    const availableFields = COHORT_FIELDS.filter((f) =>
      Boolean(fetchParams.dataView?.getFieldByName(f))
    );
    if (availableFields.length === 0) return;

    // Use the most prominent spike (highest record count) as the breakdown window.
    const topSpike = currentChangePoints.reduce((best, cp) =>
      cp.record_count > best.record_count ? cp : best
    );

    const spikeEnd = new Date(new Date(topSpike.bucket).getTime() + SPIKE_BUCKET_DURATION_MS).toISOString();
    const spikeTimeRange = { from: topSpike.bucket, to: spikeEnd };

    // Pass only the user's non-time filters — the query uses its own WHERE clause for time.
    const existingFilters = fetchParams.filters ?? [];
    const userFilter =
      existingFilters.length > 0
        ? buildEsQuery(undefined, [], existingFilters, getEsQueryConfig(services.uiSettings))
        : undefined;

    // Abort any previous cohort breakdown request before starting a new one.
    cohortBreakdownAbortRef.current?.abort();
    const abortController = new AbortController();
    cohortBreakdownAbortRef.current = abortController;

    setCohortBreakdownLoading(true);

    Promise.allSettled(
      availableFields.map((field) =>
        getESQLResults({
          esqlQuery: buildCohortBreakdownQuery(indexPattern, topSpike.bucket, field),
          search: services.data.search.search,
          signal: abortController.signal,
          filter: userFilter,
          timeRange: spikeTimeRange,
          variables: fetchParams.esqlVariables ?? [],
        })
      )
    ).then((results) => {
      if (abortController.signal.aborted) return;
      const breakdowns: Array<{ field: string; entries: Array<{ value: string; count: number }> }> =
        [];
      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const entries: Array<{ value: string; count: number }> = [];
        for (const row of result.value.response.values) {
          const r = row as unknown[];
          // Guard against unexpected column count changes in the ES|QL result shape.
          if (r.length < 2) continue;
          const value = r[1];
          if (value !== null && value !== undefined) {
            entries.push({ count: r[0] as number, value: String(value) });
          }
        }
        if (entries.length > 0) {
          breakdowns.push({ field: availableFields[i], entries });
        }
      });
      setCohortBreakdowns(breakdowns);
      setCohortBreakdownLoading(false);
    });
  }, [state.changePoints, fetchParams, indexPattern, services]);

  useEffect(() => {
    if (!indexPattern || !isComponentVisible) {
      return;
    }

    const abortController = new AbortController();
    setState({
      loading: true,
      changePoints: [],
      errorChangePoints: [],
      patterns: [],
      outliers: [],
      patternChanges: [],
      hasPreviousData: false,
      errorOutliers: [],
      patternErrorOutliers: [],
      meanCount: 0,
    });
    setCohortBreakdowns([]);
    setCohortBreakdownLoading(false);

    const { dataView, filters: existingFilters, timeRange, esqlVariables } = fetchParams;
    const uiSettings = services.uiSettings;

    // Current-period filter (used for top-patterns, outliers, and cross-period queries).
    const timeFilter =
      timeRange && dataView?.timeFieldName
        ? getTime(dataView, timeRange, { fieldName: dataView.timeFieldName })
        : undefined;
    const filtersWithTime = [...(timeFilter ? [timeFilter] : []), ...(existingFilters ?? [])];
    const filter =
      filtersWithTime.length > 0
        ? buildEsQuery(undefined, [], filtersWithTime, getEsQueryConfig(uiSettings))
        : undefined;

    // CHANGE_POINT queries use an extended time range (minimum 24 h) to ensure
    // there are always enough 30-minute buckets for statistically reliable detection.
    const changePointTimeRange = extendTimeRangeForChangePoint(timeRange);
    const changePointFilter = (() => {
      if (changePointTimeRange === timeRange) return filter;
      if (!dataView?.timeFieldName) return filter;
      const cpTimeFilter = getTime(dataView, changePointTimeRange, {
        fieldName: dataView.timeFieldName,
      });
      const cpFilters = [...(cpTimeFilter ? [cpTimeFilter] : []), ...(existingFilters ?? [])];
      return cpFilters.length > 0
        ? buildEsQuery(undefined, [], cpFilters, getEsQueryConfig(uiSettings))
        : undefined;
    })();

    // Extended filter covering [prevPeriodStart, currentEnd] for the cross-period query.
    const periodResolution = resolvePreviousPeriodTimeRange(timeRange);
    const extendedFilter = (() => {
      if (!periodResolution || !dataView?.timeFieldName) return filter;
      const extendedTimeFilter = getTime(dataView, periodResolution.extendedTimeRange, {
        fieldName: dataView.timeFieldName,
      });
      const extendedFiltersWithTime = [
        ...(extendedTimeFilter ? [extendedTimeFilter] : []),
        ...(existingFilters ?? []),
      ];
      return buildEsQuery(undefined, [], extendedFiltersWithTime, getEsQueryConfig(uiSettings));
    })();

    const changePointPromise = getESQLResults({
      esqlQuery: buildChangePointQuery(indexPattern),
      search: services.data.search.search,
      signal: abortController.signal,
      filter: changePointFilter,
      timeRange: changePointTimeRange,
      variables: esqlVariables,
    });

    const patternsPromise = getESQLResults({
      esqlQuery: buildTopPatternsQuery(indexPattern),
      search: services.data.search.search,
      signal: abortController.signal,
      filter,
      timeRange,
      variables: esqlVariables,
    });

    const crossPeriodPromise = periodResolution
      ? getESQLResults({
          esqlQuery: buildCrossPeriodQuery(indexPattern, periodResolution.currentStartIso),
          search: services.data.search.search,
          signal: abortController.signal,
          filter: extendedFilter,
          timeRange: periodResolution.extendedTimeRange,
          variables: esqlVariables,
        })
      : Promise.resolve(null);

    const outliersPromise = getESQLResults({
      esqlQuery: buildOutliersQuery(indexPattern),
      search: services.data.search.search,
      signal: abortController.signal,
      filter,
      timeRange,
      variables: esqlVariables,
    });

    // Only query error rates when log.level is present in the mapping —
    // avoids "Unknown column [log.level]" on non-ECS indices.
    const hasLogLevel = Boolean(dataView?.getFieldByName('log.level'));
    const errorRatePromise = hasLogLevel
      ? getESQLResults({
          esqlQuery: buildErrorRateChangePointQuery(indexPattern),
          search: services.data.search.search,
          signal: abortController.signal,
          filter: changePointFilter,
          timeRange: changePointTimeRange,
          variables: esqlVariables,
        })
      : Promise.resolve(null);

    // Error outlier queries: one per available cohort field, only when log.level exists.
    const errorOutlierFields = hasLogLevel
      ? COHORT_FIELDS.filter((f) => Boolean(dataView?.getFieldByName(f)))
      : [];
    const errorOutlierMetaPromise: Promise<
      Array<{ field: string; rows: Array<{ errors: number; total: number; value: string }> } | null>
    > =
      errorOutlierFields.length > 0
        ? Promise.allSettled(
            errorOutlierFields.map((field) =>
              getESQLResults({
                esqlQuery: buildErrorOutlierQuery(indexPattern, field),
                search: services.data.search.search,
                signal: abortController.signal,
                filter,
                timeRange,
                variables: esqlVariables,
              })
            )
          ).then((results) =>
            results.map((result, i) => {
              if (result.status !== 'fulfilled') return null;
              const rows = result.value.response.values
                .flatMap((row) => {
                  const r = row as unknown[];
                  if (r.length < 3) return [];
                  return [{ errors: r[0] as number, total: r[1] as number, value: String(r[2]) }];
                })
                .filter((r) => r.value !== 'null' && r.value !== 'undefined');
              return { field: errorOutlierFields[i], rows };
            })
          )
        : Promise.resolve([]);

    // Per-pattern error outliers: which log message templates are disproportionately
    // error-heavy compared to the fleet average.  Only runs when log.level exists.
    const patternErrorOutlierPromise = hasLogLevel
      ? getESQLResults({
          esqlQuery: buildPatternErrorOutlierQuery(indexPattern),
          search: services.data.search.search,
          signal: abortController.signal,
          filter,
          timeRange,
          variables: esqlVariables,
        })
      : Promise.resolve(null);

    // Mean bucket count over the change-point window — used to compute magnitude
    // ratios (e.g. "8× avg") for each detected anomaly.
    const meanCountPromise = getESQLResults({
      esqlQuery: buildMeanCountQuery(indexPattern),
      search: services.data.search.search,
      signal: abortController.signal,
      filter: changePointFilter,
      timeRange: changePointTimeRange,
      variables: esqlVariables,
    });

    Promise.allSettled([
      changePointPromise,
      patternsPromise,
      crossPeriodPromise,
      outliersPromise,
      errorRatePromise,
      errorOutlierMetaPromise,
      patternErrorOutlierPromise,
      meanCountPromise,
    ]).then(
      ([
        changePointResult,
        patternsResult,
        crossPeriodResult,
        outliersResult,
        errorRateResult,
        errorOutlierMetaResult,
        patternErrorOutlierResult,
        meanCountResult,
      ]) => {
        if (abortController.signal.aborted) {
          return;
        }

        const changePoints: ChangePoint[] = [];
        const errorChangePoints: ChangePoint[] = [];
        const patterns: { count: number; category: string }[] = [];
        const outliers: { count: number; category: string }[] = [];
        const patternChanges: PatternChange[] = [];
        let hasPreviousData = false;

        if (changePointResult.status === 'fulfilled') {
          for (const row of changePointResult.value.response.values) {
            const r = row as unknown[];
            if (r.length < 3) continue;
            changePoints.push({
              record_count: r[0] as number,
              bucket: r[1] as string,
              type: r[2] as string,
            });
          }
        }
        // Change-point failure is non-fatal: patterns section still renders.

        if (patternsResult.status === 'fulfilled') {
          for (const row of patternsResult.value.response.values) {
            const r = row as unknown[];
            if (r.length < 2) continue;
            patterns.push({ count: r[0] as number, category: r[1] as string });
          }
        }
        // Patterns failure is non-fatal: silently absent on indices without `message`.

        if (crossPeriodResult.status === 'fulfilled' && crossPeriodResult.value !== null) {
          // Columns: count (0), category (1), period (2)
          const byCategory = new Map<string, { current: number; previous: number }>();
          for (const row of crossPeriodResult.value.response.values) {
            const r = row as unknown[];
            if (r.length < 3) continue;
            const count = Number(r[0]);
            const category = String(r[1]);
            const period = String(r[2]);
            if (!byCategory.has(category)) {
              byCategory.set(category, { current: 0, previous: 0 });
            }
            const entry = byCategory.get(category)!;
            if (period === 'current') {
              entry.current = count;
            } else {
              entry.previous = count;
              hasPreviousData = true;
            }
          }

          if (hasPreviousData) {
            patternChanges.push(...diffPatterns(byCategory));
          }
        }
        // Cross-period failure is non-fatal: the panel still shows the other results.

        if (outliersResult.status === 'fulfilled') {
          for (const row of outliersResult.value.response.values) {
            const r = row as unknown[];
            if (r.length < 2) continue;
            outliers.push({ count: r[0] as number, category: r[1] as string });
          }
        }
        // Outliers failure is non-fatal: silently absent on indices without `message`.

        if (errorRateResult.status === 'fulfilled' && errorRateResult.value !== null) {
          for (const row of errorRateResult.value.response.values) {
            const r = row as unknown[];
            if (r.length < 3) continue;
            errorChangePoints.push({
              record_count: r[0] as number,
              bucket: r[1] as string,
              type: r[2] as string,
            });
          }
        }
        // Error rate failure is non-fatal: absent when log.level is missing or query fails.

        const errorOutliers: ErrorOutlier[] = [];
        if (errorOutlierMetaResult.status === 'fulfilled') {
          for (const item of errorOutlierMetaResult.value) {
            if (item) {
              errorOutliers.push(...computeErrorOutliers(item.rows, item.field));
            }
          }
        }
        // Error outlier failure is non-fatal.

        const patternErrorOutliers: PatternErrorOutlier[] = [];
        if (
          patternErrorOutlierResult.status === 'fulfilled' &&
          patternErrorOutlierResult.value !== null
        ) {
          const rows = patternErrorOutlierResult.value.response.values
            .flatMap((row) => {
              const r = row as unknown[];
              if (r.length < 3) return [];
              return [{ errors: r[0] as number, total: r[1] as number, category: String(r[2]) }];
            })
            .filter((r) => r.category !== 'null' && r.category !== 'undefined');
          patternErrorOutliers.push(...computePatternErrorOutliers(rows));
        }
        // Pattern error outlier failure is non-fatal.

        let meanCount = 0;
        if (meanCountResult.status === 'fulfilled') {
          const rows = meanCountResult.value.response.values;
          const firstRow = rows[0] as unknown[] | undefined;
          if (firstRow && firstRow.length >= 1) {
            meanCount = (firstRow[0] as number) ?? 0;
          }
        }
        // Mean count failure is non-fatal — magnitude ratios simply won't render.

        setState({
          loading: false,
          changePoints,
          errorChangePoints,
          patterns,
          outliers,
          patternChanges,
          hasPreviousData,
          errorOutliers,
          patternErrorOutliers,
          meanCount,
        });
      }
    );

    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // fetchParams is an object that changes reference on every render; we list only the
    // primitive/stable values that should actually trigger a new fetch rather than the
    // whole object, which would cause an infinite re-run loop.
  }, [
    indexPattern,
    isComponentVisible,
    fetchParams.timeRange?.from,
    fetchParams.timeRange?.to,
    fetchParams.filters,
    fetchParams.lastReloadRequestTime,
  ]);

  if (!indexPattern) {
    return null;
  }

  const {
    loading,
    changePoints,
    errorChangePoints,
    patterns,
    outliers,
    patternChanges,
    hasPreviousData,
    errorOutliers,
    patternErrorOutliers,
    meanCount,
  } = state;
  const newCount = patternChanges.filter((c) => c.kind === 'new').length;
  const spikedCount = patternChanges.filter((c) => c.kind === 'spiked').length;
  const disappearedCount = patternChanges.filter((c) => c.kind === 'disappeared').length;
  const hasChanges = hasPreviousData && patternChanges.length > 0;

  return (
    <>
      <EuiPanel hasBorder={false} hasShadow={false} paddingSize="s">
        <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" gutterSize="none">
          <EuiFlexItem grow={false}>
            <EuiTitle size="xxxs">
              <h3>
                {i18n.translate('discover.logsInsights.title', {
                  defaultMessage: "What's different",
                })}
              </h3>
            </EuiTitle>
          </EuiFlexItem>
          <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
            {aiopsService && (
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  size="xs"
                  iconType="chartBarVertical"
                  onClick={() => setFlyoutOpen(true)}
                >
                  {i18n.translate('discover.logsInsights.logRateAnalysisButton', {
                    defaultMessage: 'Log rate analysis',
                  })}
                </EuiButtonEmpty>
              </EuiFlexItem>
            )}
            <EuiFlexItem grow={false}>{renderToggleActions()}</EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexGroup>
        <EuiHorizontalRule margin="xs" />

        {loading && (
          <EuiFlexGroup alignItems="center" gutterSize="s">
            <EuiFlexItem grow={false}>
              <EuiLoadingSpinner size="s" />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="s" color="subdued">
                {i18n.translate('discover.logsInsights.loading', {
                  defaultMessage: 'Analysing logs\u2026',
                })}
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
        )}

        {!loading && (errorChangePoints.length > 0 || changePoints.length > 0) && (
          <EuiFlexGroup gutterSize="s" alignItems="stretch" responsive={false}>
            {errorChangePoints.length > 0 && (
              <EuiFlexItem>
                <KbnDangerCallout
                  announceOnMount
                  size="s"
                  className="eui-fullHeight"
                  title={i18n.translate('discover.logsInsights.errorRateChangePointsDetected', {
                    defaultMessage:
                      '{count} error-rate {count, plural, one {anomaly} other {anomalies}} detected',
                    values: { count: errorChangePoints.length },
                  })}
                >
                  <ul css={listCss}>
                    {errorChangePoints.map((cp) => (
                      <li key={cp.bucket}>
                        {formatChangePointType(cp.type)}&nbsp;&mdash;&nbsp;
                        {formatBucketTime(cp.bucket)}
                      </li>
                    ))}
                  </ul>
                  <EuiSpacer size="xs" />
                  {/* eslint-disable-next-line @elastic/eui/callout-prefer-props-for-content -- button is adjacent to a dynamic list; actionProps cannot express this layout */}
                  <EuiButtonEmpty
                    size="xs"
                    iconType="filter"
                    flush="left"
                    onClick={applyErrorLevelFilter}
                  >
                    {i18n.translate('discover.logsInsights.filterToErrorLogs', {
                      defaultMessage: 'Filter to error logs',
                    })}
                  </EuiButtonEmpty>
                </KbnDangerCallout>
              </EuiFlexItem>
            )}
            {changePoints.length > 0 && (
              <EuiFlexItem>
                <KbnWarningCallout
                  announceOnMount
                  size="s"
                  className="eui-fullHeight"
                  title={i18n.translate('discover.logsInsights.changePointsDetected', {
                    defaultMessage:
                      '{count} overall rate {count, plural, one {anomaly} other {anomalies}} detected',
                    values: { count: changePoints.length },
                  })}
                >
                  <ul css={listCss}>
                    {changePoints.map((cp) => {
                      const ratio = meanCount > 0 ? Math.round(cp.record_count / meanCount) : 0;
                      return (
                        <li key={cp.bucket}>
                          {formatChangePointType(cp.type)}&nbsp;&mdash;&nbsp;
                          {formatBucketTime(cp.bucket)}
                          {ratio >= 2 && (
                            <span css={mutedTextCss}>{`\u00a0(${ratio}\u00d7\u00a0avg)`}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {/* On-demand cohort breakdown — shows which service/host/container is driving the spike */}
                  {cohortBreakdowns.length === 0 &&
                    !cohortBreakdownLoading &&
                    COHORT_FIELDS.some((f) => Boolean(fetchParams.dataView?.getFieldByName(f))) && (
                      <>
                        <EuiSpacer size="xs" />
                        {/* eslint-disable-next-line @elastic/eui/callout-prefer-props-for-content -- conditionally rendered; actionProps cannot express conditional or multi-button layouts */}
                        <EuiButtonEmpty
                          size="xs"
                          iconType="aggregate"
                          flush="left"
                          onClick={loadCohortBreakdown}
                        >
                          {i18n.translate('discover.logsInsights.showTopContributors', {
                            defaultMessage: 'Show top contributors',
                          })}
                        </EuiButtonEmpty>
                      </>
                    )}
                  {cohortBreakdownLoading && (
                    <>
                      <EuiSpacer size="xs" />
                      <EuiFlexGroup alignItems="center" gutterSize="xs">
                        <EuiFlexItem grow={false}>
                          <EuiLoadingSpinner size="s" />
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          {/* eslint-disable-next-line @elastic/eui/callout-prefer-props-for-content -- inline text within a FlexGroup loading indicator; text prop does not support this layout */}
                          <EuiText size="xs" color="subdued">
                            {i18n.translate('discover.logsInsights.loadingBreakdown', {
                              defaultMessage: 'Loading breakdown\u2026',
                            })}
                          </EuiText>
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    </>
                  )}
                  {cohortBreakdowns.map((breakdown) => (
                    <React.Fragment key={breakdown.field}>
                      <EuiSpacer size="xs" />
                      {/* eslint-disable-next-line @elastic/eui/callout-prefer-props-for-content -- label rendered per-breakdown iteration; text prop does not support mapped content */}
                      <EuiText size="xs" color="subdued">
                        <strong>{COHORT_FIELD_LABELS[breakdown.field] ?? breakdown.field}</strong>
                      </EuiText>
                      <EuiSpacer size="xs" />
                      <EuiFlexGroup wrap gutterSize="xs">
                        {breakdown.entries.map((entry) => (
                          <EuiFlexItem grow={false} key={entry.value}>
                            <EuiBadge
                              color="hollow"
                              onClick={() => applyCohortFilter(breakdown.field, entry.value)}
                              onClickAriaLabel={i18n.translate(
                                'discover.logsInsights.filterByCohort',
                                {
                                  defaultMessage: 'Filter to this {field}',
                                  values: {
                                    field: COHORT_FIELD_LABELS[breakdown.field] ?? breakdown.field,
                                  },
                                }
                              )}
                            >
                              {`${truncate(entry.value, 40)} (${entry.count})`}
                            </EuiBadge>
                          </EuiFlexItem>
                        ))}
                      </EuiFlexGroup>
                    </React.Fragment>
                  ))}
                  {aiopsService && (
                    <>
                      <EuiSpacer size="xs" />
                      {/* eslint-disable-next-line @elastic/eui/callout-prefer-props-for-content -- conditionally rendered; actionProps cannot express conditional or multi-button layouts */}
                      <EuiButtonEmpty
                        size="xs"
                        iconType="chartBarVertical"
                        flush="left"
                        onClick={() => setFlyoutOpen(true)}
                      >
                        {i18n.translate('discover.logsInsights.openLogRateAnalysis', {
                          defaultMessage: 'Open log rate analysis',
                        })}
                      </EuiButtonEmpty>
                    </>
                  )}
                </KbnWarningCallout>
              </EuiFlexItem>
            )}
          </EuiFlexGroup>
        )}

        {!loading && (
          <>
            <EuiSpacer size="xs" />
            <EuiAccordion
              id="logsInsights__errorOutliers"
              buttonContent={
                <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <strong>
                        {i18n.translate('discover.logsInsights.errorOutliersLabel', {
                          defaultMessage: 'Error outliers',
                        })}
                      </strong>
                    </EuiText>
                  </EuiFlexItem>
                  {errorOutliers.length > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="danger">{errorOutliers.length}</EuiBadge>
                    </EuiFlexItem>
                  )}
                </EuiFlexGroup>
              }
              {...(mounted
                ? { forceState: openSections.errorOutliers ? 'open' : 'closed' }
                : { initialIsOpen: openSections.errorOutliers })}
              onToggle={() => toggleSection('errorOutliers')}
            >
              <EuiSpacer size="xs" />
              {errorOutliers.length > 0 ? (
                <EuiFlexGroup wrap gutterSize="xs">
                  {errorOutliers.slice(0, MAX_DISPLAYED_OUTLIERS).map((outlier) => {
                    const pct = Math.round(outlier.errorRate * 100);
                    const ratio = Math.round(outlier.errorRate / outlier.fleetErrorRate);
                    const label = COHORT_FIELD_LABELS[outlier.field] ?? outlier.field;
                    return (
                      <EuiFlexItem grow={false} key={`${outlier.field}:${outlier.value}`}>
                        <EuiBadge
                          color="danger"
                          onClick={() => applyOutlierFilter(outlier.field, outlier.value)}
                          onClickAriaLabel={i18n.translate(
                            'discover.logsInsights.filterByErrorOutlier',
                            {
                              defaultMessage: 'Filter to errors from this {field}',
                              values: { field: label },
                            }
                          )}
                        >
                          {`${truncate(
                            outlier.value,
                            40
                          )} \u2014 ${pct}% errors (${ratio}\u00d7 avg)`}
                        </EuiBadge>
                      </EuiFlexItem>
                    );
                  })}
                </EuiFlexGroup>
              ) : (
                <EuiText size="xs" color="subdued">
                  {i18n.translate('discover.logsInsights.errorOutliersNone', {
                    defaultMessage: 'None detected',
                  })}
                </EuiText>
              )}
            </EuiAccordion>
          </>
        )}

        {!loading && (
          <>
            <EuiSpacer size="xs" />
            <EuiAccordion
              id="logsInsights__patternErrorOutliers"
              buttonContent={
                <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <strong>
                        {i18n.translate('discover.logsInsights.patternErrorOutliersLabel', {
                          defaultMessage: 'Error-prone patterns',
                        })}
                      </strong>
                    </EuiText>
                  </EuiFlexItem>
                  {patternErrorOutliers.length > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="danger">{patternErrorOutliers.length}</EuiBadge>
                    </EuiFlexItem>
                  )}
                </EuiFlexGroup>
              }
              {...(mounted
                ? { forceState: openSections.patternErrorOutliers ? 'open' : 'closed' }
                : { initialIsOpen: openSections.patternErrorOutliers })}
              onToggle={() => toggleSection('patternErrorOutliers')}
            >
              <EuiSpacer size="xs" />
              {patternErrorOutliers.length > 0 ? (
                <EuiFlexGroup wrap gutterSize="xs">
                  {patternErrorOutliers.slice(0, MAX_DISPLAYED_OUTLIERS).map((outlier) => {
                    const pct = Math.round(outlier.errorRate * 100);
                    const ratio = Math.round(outlier.errorRate / outlier.fleetErrorRate);
                    return (
                      <EuiFlexItem grow={false} key={outlier.category}>
                        <EuiBadge
                          color="danger"
                          onClick={() => applyMessageFilter(outlier.category)}
                          onClickAriaLabel={i18n.translate(
                            'discover.logsInsights.filterByPatternErrorOutlier',
                            { defaultMessage: 'Filter to logs matching this error-prone pattern' }
                          )}
                        >
                          {`${truncate(
                            outlier.category,
                            50
                          )} \u2014 ${pct}% errors (${ratio}\u00d7 avg)`}
                        </EuiBadge>
                      </EuiFlexItem>
                    );
                  })}
                </EuiFlexGroup>
              ) : (
                <EuiText size="xs" color="subdued">
                  {i18n.translate('discover.logsInsights.patternErrorOutliersNone', {
                    defaultMessage: 'None detected',
                  })}
                </EuiText>
              )}
            </EuiAccordion>
          </>
        )}

        {!loading && (
          <>
            <EuiSpacer size="xs" />
            <EuiAccordion
              id="logsInsights__patternChanges"
              buttonContent={
                <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <strong>
                        {i18n.translate('discover.logsInsights.comparedToPrevious', {
                          defaultMessage: 'Compared to previous period',
                        })}
                      </strong>
                    </EuiText>
                  </EuiFlexItem>
                  {newCount > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="danger">{`\u2191${newCount} new`}</EuiBadge>
                    </EuiFlexItem>
                  )}
                  {spikedCount > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="warning">{`\u2191${spikedCount} spiked`}</EuiBadge>
                    </EuiFlexItem>
                  )}
                  {disappearedCount > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="default">{`\u2193${disappearedCount} gone`}</EuiBadge>
                    </EuiFlexItem>
                  )}
                </EuiFlexGroup>
              }
              {...(mounted
                ? { forceState: openSections.patternChanges ? 'open' : 'closed' }
                : { initialIsOpen: openSections.patternChanges })}
              onToggle={() => toggleSection('patternChanges')}
            >
              <EuiSpacer size="xs" />
              {hasChanges ? (
                <EuiFlexGroup wrap gutterSize="xs">
                  {(['new', 'spiked', 'disappeared'] as PatternChangeKind[])
                    .flatMap((kind) => patternChanges.filter((c) => c.kind === kind).slice(0, 3))
                    .map((change) => (
                      <EuiFlexItem grow={false} key={`${change.kind}:${change.category}`}>
                        <EuiBadge
                          color={BADGE_COLOR_BY_KIND[change.kind]}
                          onClick={() => applyMessageFilter(change.category)}
                          onClickAriaLabel={i18n.translate(
                            'discover.logsInsights.filterByPattern',
                            { defaultMessage: 'Filter by this pattern' }
                          )}
                        >
                          {`${getBadgeLabelByKind(change)}\u00a0${truncate(change.category, 60)} (${
                            change.kind === 'disappeared'
                              ? change.previousCount
                              : change.currentCount
                          })`}
                        </EuiBadge>
                      </EuiFlexItem>
                    ))}
                </EuiFlexGroup>
              ) : (
                <EuiText size="xs" color="subdued">
                  {i18n.translate('discover.logsInsights.patternChangesNone', {
                    defaultMessage: 'None detected',
                  })}
                </EuiText>
              )}
            </EuiAccordion>
          </>
        )}

        {!loading && (
          <>
            <EuiSpacer size="xs" />
            <EuiAccordion
              id="logsInsights__outliers"
              buttonContent={
                <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <strong>
                        {i18n.translate('discover.logsInsights.outliersLabel', {
                          defaultMessage: 'Rare events',
                        })}
                      </strong>
                    </EuiText>
                  </EuiFlexItem>
                  {outliers.length > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="accent">{outliers.length}</EuiBadge>
                    </EuiFlexItem>
                  )}
                </EuiFlexGroup>
              }
              {...(mounted
                ? { forceState: openSections.outliers ? 'open' : 'closed' }
                : { initialIsOpen: openSections.outliers })}
              onToggle={() => toggleSection('outliers')}
            >
              <EuiSpacer size="xs" />
              {outliers.length > 0 ? (
                <EuiFlexGroup wrap gutterSize="xs">
                  {outliers.map((outlier) => (
                    <EuiFlexItem grow={false} key={outlier.category}>
                      <EuiBadge
                        color="accent"
                        onClick={() => applyMessageFilter(outlier.category)}
                        onClickAriaLabel={i18n.translate('discover.logsInsights.filterByOutlier', {
                          defaultMessage: 'Filter by this rare event',
                        })}
                      >
                        {`${truncate(outlier.category, 60)} (${outlier.count})`}
                      </EuiBadge>
                    </EuiFlexItem>
                  ))}
                </EuiFlexGroup>
              ) : (
                <EuiText size="xs" color="subdued">
                  {i18n.translate('discover.logsInsights.outliersNone', {
                    defaultMessage: 'None detected',
                  })}
                </EuiText>
              )}
            </EuiAccordion>
          </>
        )}

        {!loading && (
          <>
            <EuiSpacer size="xs" />
            <EuiAccordion
              id="logsInsights__patterns"
              buttonContent={
                <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <strong>
                        {i18n.translate('discover.logsInsights.topPatternsLabel', {
                          defaultMessage: 'Top log patterns',
                        })}
                      </strong>
                    </EuiText>
                  </EuiFlexItem>
                  {patterns.length > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="hollow">{patterns.length}</EuiBadge>
                    </EuiFlexItem>
                  )}
                </EuiFlexGroup>
              }
              {...(mounted
                ? { forceState: openSections.patterns ? 'open' : 'closed' }
                : { initialIsOpen: openSections.patterns })}
              onToggle={() => toggleSection('patterns')}
            >
              <EuiSpacer size="xs" />
              {patterns.length > 0 ? (
                <EuiFlexGroup wrap gutterSize="xs">
                  {patterns.map((pattern) => (
                    <EuiFlexItem grow={false} key={pattern.category}>
                      <EuiBadge
                        color="hollow"
                        onClick={() => applyMessageFilter(pattern.category)}
                        onClickAriaLabel={i18n.translate(
                          'discover.logsInsights.filterByTopPattern',
                          { defaultMessage: 'Filter by this pattern' }
                        )}
                      >
                        {`${truncate(pattern.category, 70)} (${pattern.count})`}
                      </EuiBadge>
                    </EuiFlexItem>
                  ))}
                </EuiFlexGroup>
              ) : (
                <EuiText size="xs" color="subdued">
                  {i18n.translate('discover.logsInsights.patternsNone', {
                    defaultMessage: 'None detected',
                  })}
                </EuiText>
              )}
            </EuiAccordion>
          </>
        )}
      </EuiPanel>

      {flyoutOpen && (
        <LogRateAnalysisFlyout
          fetchParams={fetchParams}
          services={services}
          onClose={() => setFlyoutOpen(false)}
        />
      )}
    </>
  );
};
