/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { i18n } from '@kbn/i18n';
import dateMath from '@kbn/datemath';
import type { TimeRange } from '@kbn/es-query';

export interface ChangePoint {
  record_count: number;
  bucket: string;
  type: string;
}

export interface LogPattern {
  count: number;
  category: string;
}

export type PatternChangeKind = 'new' | 'disappeared' | 'spiked';

export interface PatternChange {
  category: string;
  kind: PatternChangeKind;
  currentCount: number;
  previousCount: number;
}

export interface ErrorOutlier {
  field: string;
  value: string;
  /** Error rate for this field value (0–1). */
  errorRate: number;
  errorCount: number;
  totalCount: number;
  /** Fleet-wide average error rate across all values of this field (0–1). */
  fleetErrorRate: number;
}

export interface PatternErrorOutlier {
  category: string;
  /** Error rate for this pattern (0–1). */
  errorRate: number;
  errorCount: number;
  totalCount: number;
  /** Fleet-wide average error rate across all patterns (0–1). */
  fleetErrorRate: number;
}

export interface InsightsState {
  loading: boolean;
  changePoints: ChangePoint[];
  errorChangePoints: ChangePoint[];
  patterns: LogPattern[];
  outliers: LogPattern[];
  patternChanges: PatternChange[];
  hasPreviousData: boolean;
  errorOutliers: ErrorOutlier[];
  patternErrorOutliers: PatternErrorOutlier[];
  /** Average log count per 30-minute bucket over the change-point window, used to show magnitude ratios. */
  meanCount: number;
}

export const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}\u2026` : s;

export const formatBucketTime = (isoString: string): string => {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const CHANGE_POINT_TYPE_LABELS: Record<string, string> = {
  spike: i18n.translate('discover.logsInsights.changePointType.spike', {
    defaultMessage: 'Spike',
  }),
  dip: i18n.translate('discover.logsInsights.changePointType.dip', {
    defaultMessage: 'Dip',
  }),
  step_change: i18n.translate('discover.logsInsights.changePointType.stepChange', {
    defaultMessage: 'Step change',
  }),
  distribution_change: i18n.translate('discover.logsInsights.changePointType.distributionChange', {
    defaultMessage: 'Distribution change',
  }),
  trend_change: i18n.translate('discover.logsInsights.changePointType.trendChange', {
    defaultMessage: 'Trend change',
  }),
};

export const formatChangePointType = (type: string): string =>
  CHANGE_POINT_TYPE_LABELS[type.toLowerCase()] ?? type;

export const BADGE_COLOR_BY_KIND: Record<PatternChangeKind, string> = {
  new: 'danger',
  spiked: 'warning',
  disappeared: 'default',
};

export const getBadgeLabelByKind = (change: PatternChange): string => {
  if (change.kind === 'new') return '\u2191 new';
  if (change.kind === 'disappeared') return '\u2193 gone';
  const ratio = Math.round(change.currentCount / change.previousCount);
  return `\u2191\u00a0${ratio}x`;
};

export const ACCORDION_STORAGE_KEY = 'logsInsights.accordionState';

export const DEFAULT_OPEN_SECTIONS: Record<string, boolean> = {
  errorOutliers: true,
  patternErrorOutliers: true,
  patternChanges: true,
  outliers: false,
  patterns: false,
};

/**
 * ECS fields checked in priority order when looking for a grouping dimension
 * that can explain which service/host/container is driving a spike.
 */
export const COHORT_FIELDS = [
  'service.name',
  'host.name',
  'container.name',
  'kubernetes.pod.name',
  'log.logger',
];

export const COHORT_FIELD_LABELS: Record<string, string> = {
  'service.name': i18n.translate('discover.logsInsights.cohortField.serviceName', {
    defaultMessage: 'Service',
  }),
  'host.name': i18n.translate('discover.logsInsights.cohortField.hostName', {
    defaultMessage: 'Host',
  }),
  'container.name': i18n.translate('discover.logsInsights.cohortField.containerName', {
    defaultMessage: 'Container',
  }),
  'kubernetes.pod.name': i18n.translate('discover.logsInsights.cohortField.podName', {
    defaultMessage: 'Pod',
  }),
  'log.logger': i18n.translate('discover.logsInsights.cohortField.logger', {
    defaultMessage: 'Logger',
  }),
};

/**
 * Resolves a potentially-relative TimeRange to absolute ISO strings and
 * derives the previous period (same duration, immediately preceding).
 *
 * Returns the extended time range [prevStart, currentEnd] used for the
 * cross-period query, and the currentStart ISO string needed for the
 * ES|QL EVAL period split.
 *
 * Exported for unit testing.
 */
export function resolvePreviousPeriodTimeRange(timeRange: TimeRange): {
  extendedTimeRange: TimeRange;
  currentStartIso: string;
} | null {
  const currentEnd = dateMath.parse(timeRange.to, { roundUp: true });
  const currentStart = dateMath.parse(timeRange.from);
  if (!currentEnd || !currentStart || !currentEnd.isValid() || !currentStart.isValid()) {
    return null;
  }
  const durationMs = currentEnd.valueOf() - currentStart.valueOf();
  if (durationMs <= 0) {
    return null;
  }
  const prevStart = new Date(currentStart.valueOf() - durationMs);
  return {
    extendedTimeRange: {
      from: prevStart.toISOString(),
      to: currentEnd.toDate().toISOString(),
    },
    currentStartIso: currentStart.toDate().toISOString(),
  };
}

/**
 * Diffs two period counts from a cross-period CATEGORIZE result into typed
 * pattern change signals (new / disappeared / spiked), sorted by prominence.
 *
 * Exported for unit testing.
 */
export function diffPatterns(
  byCategory: Map<string, { current: number; previous: number }>
): PatternChange[] {
  const changes: PatternChange[] = [];
  for (const [category, { current, previous }] of byCategory) {
    if (current > 0 && previous === 0) {
      changes.push({ category, kind: 'new', currentCount: current, previousCount: 0 });
    } else if (current === 0 && previous > 0) {
      changes.push({ category, kind: 'disappeared', currentCount: 0, previousCount: previous });
    } else if (current > previous * 2 && current >= 5) {
      changes.push({ category, kind: 'spiked', currentCount: current, previousCount: previous });
    }
  }
  const kindOrder: Record<PatternChangeKind, number> = { new: 0, spiked: 1, disappeared: 2 };
  return changes.sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.currentCount - a.currentCount
  );
}

/**
 * Computes per-field error outliers: values whose error rate is at least 2×
 * the fleet-wide average for that field.  Exported for unit testing.
 *
 * @param rows   Raw rows from `buildErrorOutlierQuery` (errors, total, value).
 * @param field  The ECS field that was grouped (e.g. "service.name").
 */
export function computeErrorOutliers(
  rows: Array<{ errors: number; total: number; value: string }>,
  field: string
): ErrorOutlier[] {
  const totalErrors = rows.reduce((sum, r) => sum + r.errors, 0);
  const totalCount = rows.reduce((sum, r) => sum + r.total, 0);
  if (totalCount === 0 || totalErrors === 0) return [];
  const fleetErrorRate = totalErrors / totalCount;
  return rows
    .filter((r) => r.errors >= 5 && r.total > 0)
    .map((r) => ({
      field,
      value: r.value,
      errorRate: r.errors / r.total,
      errorCount: r.errors,
      totalCount: r.total,
      fleetErrorRate,
    }))
    .filter((r) => r.errorRate > fleetErrorRate * 2)
    .sort((a, b) => b.errorRate - a.errorRate);
}

/**
 * Same outlier logic as `computeErrorOutliers` but applied to log *patterns*
 * (CATEGORIZE output) rather than field values.  Exported for unit testing.
 */
export function computePatternErrorOutliers(
  rows: Array<{ errors: number; total: number; category: string }>
): PatternErrorOutlier[] {
  const totalErrors = rows.reduce((sum, r) => sum + r.errors, 0);
  const totalCount = rows.reduce((sum, r) => sum + r.total, 0);
  if (totalCount === 0 || totalErrors === 0) return [];
  const fleetErrorRate = totalErrors / totalCount;
  return rows
    .filter((r) => r.errors >= 5 && r.total > 0)
    .map((r) => ({
      category: r.category,
      errorRate: r.errors / r.total,
      errorCount: r.errors,
      totalCount: r.total,
      fleetErrorRate,
    }))
    .filter((r) => r.errorRate > fleetErrorRate * 2)
    .sort((a, b) => b.errorRate - a.errorRate);
}

export const buildChangePointQuery = (indexPattern: string) => `FROM ${indexPattern}
| STATS record_count = COUNT(*) BY bucket = BUCKET(@timestamp, 30 minute)
| CHANGE_POINT record_count ON bucket
| WHERE type IS NOT NULL
| SORT bucket ASC
| LIMIT 5`;

/**
 * Same as buildChangePointQuery but pre-filters to error/critical levels.
 * Only used when log.level exists in the data view mapping.
 */
export const buildErrorRateChangePointQuery = (indexPattern: string) => `FROM ${indexPattern}
| WHERE log.level IN ("error", "ERROR", "critical", "CRITICAL")
| STATS error_count = COUNT(*) BY bucket = BUCKET(@timestamp, 30 minute)
| CHANGE_POINT error_count ON bucket
| WHERE type IS NOT NULL
| SORT bucket ASC
| LIMIT 5`;

export const buildTopPatternsQuery = (indexPattern: string) => `FROM ${indexPattern}
| LIMIT 50000
| STATS count = COUNT(*) BY category = CATEGORIZE(message, {"output_format": "tokens"})
| SORT count DESC
| LIMIT 8`;

/**
 * Returns patterns that appear at most twice in the window — genuine rare
 * events that stand out against the normal log volume.  Non-fatal: silently
 * absent on indices without a `message` field.
 */
export const buildOutliersQuery = (indexPattern: string) => `FROM ${indexPattern}
| LIMIT 50000
| STATS count = COUNT(*) BY category = CATEGORIZE(message, {"output_format": "tokens"})
| WHERE count <= 2
| SORT count ASC
| LIMIT 5`;

/**
 * Spans both the current window and the equal-duration preceding window in a
 * single query so CATEGORIZE derives consistent categories across both periods.
 * The EVAL splits rows into "current" / "previous" for the JS diff below.
 */
export const buildCrossPeriodQuery = (indexPattern: string, currentStartIso: string) =>
  `FROM ${indexPattern}
| EVAL period = CASE(@timestamp < "${currentStartIso}", "previous", "current")
| STATS count = COUNT(*) BY category = CATEGORIZE(message, {"output_format": "tokens"}), period
| LIMIT 200`;

/**
 * Per-field error-outlier query.
 * Columns: errors (0), total (1), <field> (2).
 * Only used when log.level exists in the data view mapping.
 */
export const buildErrorOutlierQuery = (indexPattern: string, field: string) => `FROM ${indexPattern}
| EVAL _err = CASE(log.level IN ("error", "ERROR", "critical", "CRITICAL"), 1, 0)
| STATS errors = SUM(_err), total = COUNT(*) BY ${field}
| WHERE total > 0
| SORT errors DESC
| LIMIT 20`;

/**
 * Per-pattern error-outlier query.
 * Columns: errors (0), total (1), category (2).
 * Only used when log.level exists in the data view mapping.
 */
export const buildPatternErrorOutlierQuery = (indexPattern: string) => `FROM ${indexPattern}
| EVAL _err = CASE(log.level IN ("error", "ERROR", "critical", "CRITICAL"), 1, 0)
| LIMIT 50000
| STATS errors = SUM(_err), total = COUNT(*) BY category = CATEGORIZE(message, {"output_format": "tokens"})
| WHERE total > 0
| SORT errors DESC
| LIMIT 20`;

/**
 * Returns the average number of log events per 30-minute bucket over the
 * queried window.  Used to show magnitude ratios ("8× avg") alongside
 * CHANGE_POINT anomalies so users can gauge severity at a glance.
 * Columns: avg_count (0).
 */
export const buildMeanCountQuery = (indexPattern: string) => `FROM ${indexPattern}
| STATS record_count = COUNT(*) BY bucket = BUCKET(@timestamp, 30 minute)
| STATS avg_count = AVG(record_count)`;

/**
 * Groups events within a single 30-minute CHANGE_POINT bucket by a cohort
 * field (e.g. service.name) to surface which dimension is driving the spike.
 * Columns returned: count (0), <field> (1).
 */
export const buildCohortBreakdownQuery = (
  indexPattern: string,
  bucketIso: string,
  field: string
) => {
  const bucketEnd = new Date(new Date(bucketIso).getTime() + 30 * 60 * 1000).toISOString();
  return `FROM ${indexPattern}
| WHERE @timestamp >= "${bucketIso}" AND @timestamp < "${bucketEnd}"
| STATS count = COUNT(*) BY ${field}
| SORT count DESC
| LIMIT 5`;
};

/**
 * Ensures CHANGE_POINT queries always cover at least 24 hours so the command
 * has enough data points (at 30-minute buckets, that is ≥ 48 points) to
 * produce statistically meaningful results even when the user has selected a
 * short time window.
 */
export const MIN_CHANGE_POINT_MS = 24 * 60 * 60 * 1000;

export const extendTimeRangeForChangePoint = (timeRange: TimeRange): TimeRange => {
  const end = dateMath.parse(timeRange.to, { roundUp: true });
  const start = dateMath.parse(timeRange.from);
  if (!end || !start) return timeRange;
  if (end.valueOf() - start.valueOf() >= MIN_CHANGE_POINT_MS) return timeRange;
  return {
    from: new Date(end.valueOf() - MIN_CHANGE_POINT_MS).toISOString(),
    to: timeRange.to,
  };
};
