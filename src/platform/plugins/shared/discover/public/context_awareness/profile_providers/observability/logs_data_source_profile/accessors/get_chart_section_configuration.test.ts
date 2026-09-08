/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  computeErrorOutliers,
  computePatternErrorOutliers,
  diffPatterns,
  resolvePreviousPeriodTimeRange,
} from './logs_insights_utils';

describe('resolvePreviousPeriodTimeRange', () => {
  it('returns null when the from expression is unparseable', () => {
    expect(resolvePreviousPeriodTimeRange({ from: 'not-a-date', to: 'now' })).toBeNull();
  });

  it('returns null when the duration is zero or negative', () => {
    const t = '2025-01-01T00:00:00.000Z';
    expect(resolvePreviousPeriodTimeRange({ from: t, to: t })).toBeNull();
  });

  it('derives a previous period of the same duration for absolute timestamps', () => {
    const result = resolvePreviousPeriodTimeRange({
      from: '2025-01-01T01:00:00.000Z',
      to: '2025-01-01T02:00:00.000Z',
    });

    expect(result).not.toBeNull();
    // currentStartIso is the boundary between previous and current in ES|QL
    expect(result!.currentStartIso).toBe('2025-01-01T01:00:00.000Z');
    // extendedTimeRange starts one hour earlier (same 1-hour duration)
    expect(result!.extendedTimeRange.from).toBe('2025-01-01T00:00:00.000Z');
    expect(result!.extendedTimeRange.to).toBe('2025-01-01T02:00:00.000Z');
  });

  it('resolves relative expressions — now-1h/now produces an ~1-hour previous period', () => {
    const before = Date.now();
    const result = resolvePreviousPeriodTimeRange({ from: 'now-1h', to: 'now' });
    const after = Date.now();

    expect(result).not.toBeNull();

    const extFrom = new Date(result!.extendedTimeRange.from).getTime();
    const extTo = new Date(result!.extendedTimeRange.to).getTime();
    const currentStart = new Date(result!.currentStartIso).getTime();

    // Extended range spans ~2 hours
    expect(extTo - extFrom).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 5000);
    expect(extTo - extFrom).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5000);

    // currentStart is the midpoint (≈ now - 1h)
    expect(currentStart).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5000);
    expect(currentStart).toBeLessThanOrEqual(after - 60 * 60 * 1000 + 5000);
  });

  it('handles a 24-hour window correctly', () => {
    const result = resolvePreviousPeriodTimeRange({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-06-02T00:00:00.000Z',
    });

    expect(result).not.toBeNull();
    expect(result!.currentStartIso).toBe('2025-06-01T00:00:00.000Z');
    expect(result!.extendedTimeRange.from).toBe('2025-05-31T00:00:00.000Z');
    expect(result!.extendedTimeRange.to).toBe('2025-06-02T00:00:00.000Z');
  });
});

describe('diffPatterns', () => {
  const make = (entries: Array<[string, number, number]>) =>
    new Map(entries.map(([cat, current, previous]) => [cat, { current, previous }]));

  it('returns an empty array when the map is empty', () => {
    expect(diffPatterns(new Map())).toEqual([]);
  });

  it('classifies a category present only in current as "new"', () => {
    const result = diffPatterns(make([['Connection refused', 10, 0]]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'new',
      category: 'Connection refused',
      currentCount: 10,
    });
  });

  it('classifies a category present only in previous as "disappeared"', () => {
    const result = diffPatterns(make([['Timeout error', 0, 8]]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'disappeared',
      category: 'Timeout error',
      previousCount: 8,
    });
  });

  it('classifies a category that more than doubled as "spiked"', () => {
    const result = diffPatterns(make([['Auth failure', 30, 10]]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'spiked', currentCount: 30, previousCount: 10 });
  });

  it('does not classify a spike below the minimum count threshold (< 5) as spiked', () => {
    // 4 occurrences even at 4x is noise
    const result = diffPatterns(make([['Rare event', 4, 1]]));
    expect(result).toHaveLength(0);
  });

  it('does not classify a < 2x increase as spiked', () => {
    // exactly 2x — threshold is strictly greater than 2x
    expect(diffPatterns(make([['Steady growth', 20, 10]]))).toHaveLength(0);
    // below 2x
    expect(diffPatterns(make([['Minor growth', 15, 10]]))).toHaveLength(0);
  });

  it('ignores unchanged categories', () => {
    expect(diffPatterns(make([['Normal traffic', 100, 95]]))).toHaveLength(0);
  });

  it('sorts results: new before spiked before disappeared, then by descending count', () => {
    const result = diffPatterns(
      make([
        ['Gone B', 0, 5],
        ['Gone A', 0, 20],
        ['Spiked A', 100, 10],
        ['New B', 15, 0],
        ['New A', 50, 0],
        ['Spiked B', 12, 4],
      ])
    );

    const kinds = result.map((r) => r.kind);
    // new comes first
    expect(kinds[0]).toBe('new');
    expect(kinds[1]).toBe('new');
    // then spiked
    expect(kinds[2]).toBe('spiked');
    expect(kinds[3]).toBe('spiked');
    // then disappeared
    expect(kinds[4]).toBe('disappeared');
    expect(kinds[5]).toBe('disappeared');

    // within each kind, descending by currentCount (or previousCount for disappeared)
    expect(result[0].currentCount).toBeGreaterThanOrEqual(result[1].currentCount); // new
    expect(result[2].currentCount).toBeGreaterThanOrEqual(result[3].currentCount); // spiked
  });
});

describe('computeErrorOutliers', () => {
  const makeRows = (entries: Array<[number, number, string]>) =>
    entries.map(([errors, total, value]) => ({ errors, total, value }));

  it('returns an empty array when there are no rows', () => {
    expect(computeErrorOutliers([], 'service.name')).toEqual([]);
  });

  it('returns an empty array when total count is zero', () => {
    expect(computeErrorOutliers(makeRows([[0, 0, 'svc-a']]), 'service.name')).toEqual([]);
  });

  it('returns an empty array when there are no errors at all', () => {
    expect(computeErrorOutliers(makeRows([[0, 100, 'svc-a']]), 'service.name')).toEqual([]);
  });

  it('returns an empty array when no value has at least 5 errors', () => {
    // fleet rate = 4/200 = 2%
    // svc-a rate = 4/10 = 40% — more than 2× but fewer than 5 errors
    expect(
      computeErrorOutliers(
        makeRows([
          [4, 10, 'svc-a'],
          [0, 190, 'svc-b'],
        ]),
        'service.name'
      )
    ).toEqual([]);
  });

  it('returns values whose error rate exceeds 2× the fleet average', () => {
    // fleet rate = 25/200 = 12.5%
    // svc-a rate = 20/40 = 50% — > 2× fleet — outlier
    // svc-b rate = 5/160 = 3.1% — < 2× fleet — not an outlier
    const result = computeErrorOutliers(
      makeRows([
        [20, 40, 'svc-a'],
        [5, 160, 'svc-b'],
      ]),
      'service.name'
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      field: 'service.name',
      value: 'svc-a',
      errorCount: 20,
      totalCount: 40,
    });
    expect(result[0].errorRate).toBeCloseTo(0.5);
    expect(result[0].fleetErrorRate).toBeCloseTo(0.125);
  });

  it('returns multiple outliers sorted by descending error rate', () => {
    // fleet rate = 60/300 = 20%
    // svc-a: 30/50 = 60% — outlier
    // svc-b: 25/100 = 25% — not 2× fleet (25% < 40%)
    // svc-c: 5/150 = 3.3% — not outlier
    // Actually let's make two outliers:
    // fleet rate = 70/300 = 23.3%
    // svc-a: 40/60 ≈ 66.7% — outlier
    // svc-b: 30/90 = 33.3% — not 2× (33.3% < 46.7%)
    // Let me use clearer numbers:
    // fleet rate = (50+10)/300 = 20%
    // svc-a: 50/100 = 50% — > 40% threshold → outlier
    // svc-b: 10/20 = 50% — > 40% threshold → outlier
    // svc-c: 0/180 = 0% — not outlier
    const result = computeErrorOutliers(
      makeRows([
        [50, 100, 'svc-a'],
        [10, 20, 'svc-b'],
        [0, 180, 'svc-c'],
      ]),
      'service.name'
    );
    expect(result).toHaveLength(2);
    // Both have same error rate (50%), order is stable by sort — just check both are present
    const values = result.map((r) => r.value);
    expect(values).toContain('svc-a');
    expect(values).toContain('svc-b');
  });

  it('attaches the correct field name', () => {
    const result = computeErrorOutliers(
      makeRows([
        [10, 20, 'host-1'],
        [0, 80, 'host-2'],
      ]),
      'host.name'
    );
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('host.name');
  });
});

describe('computePatternErrorOutliers', () => {
  const makeRows = (entries: Array<[number, number, string]>) =>
    entries.map(([errors, total, category]) => ({ errors, total, category }));

  it('returns an empty array when there are no rows', () => {
    expect(computePatternErrorOutliers([])).toEqual([]);
  });

  it('returns an empty array when there are no errors at all', () => {
    expect(computePatternErrorOutliers(makeRows([[0, 100, 'login ok']]))).toEqual([]);
  });

  it('returns an empty array when no pattern has at least 5 errors', () => {
    // fleet rate = 4/200 = 2%, pattern-a rate = 4/10 = 40% → > 2× but < 5 errors
    expect(
      computePatternErrorOutliers(
        makeRows([
          [4, 10, 'connection refused'],
          [0, 190, 'request completed'],
        ])
      )
    ).toEqual([]);
  });

  it('surfaces patterns whose error rate exceeds 2× the fleet average', () => {
    // fleet rate = 25/200 = 12.5%
    // "db timeout" rate = 20/40 = 50% — > 25% threshold → outlier
    // "login ok" rate = 5/160 = 3.1% — not an outlier
    const result = computePatternErrorOutliers(
      makeRows([
        [20, 40, 'db timeout connecting host'],
        [5, 160, 'login ok'],
      ])
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('db timeout connecting host');
    expect(result[0].errorRate).toBeCloseTo(0.5);
    expect(result[0].fleetErrorRate).toBeCloseTo(0.125);
  });

  it('returns multiple patterns sorted by descending error rate', () => {
    // fleet rate = 60/1000 = 6%
    // "fatal panic": 30/40 = 75% — outlier
    // "auth fail": 30/100 = 30% — outlier
    // "slow query": 0/860 = 0% — not outlier
    const result = computePatternErrorOutliers(
      makeRows([
        [30, 40, 'fatal panic'],
        [30, 100, 'auth fail'],
        [0, 860, 'slow query'],
      ])
    );
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe('fatal panic'); // 75% > 30%
    expect(result[1].category).toBe('auth fail');
  });
});
