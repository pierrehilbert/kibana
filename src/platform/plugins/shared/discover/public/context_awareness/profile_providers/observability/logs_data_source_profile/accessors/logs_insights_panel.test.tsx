/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type {
  ChartSectionProps,
  UnifiedHistogramFetchParams,
  UnifiedHistogramServices,
} from '@kbn/unified-histogram/types';
import { getESQLResults } from '@kbn/esql-utils';
import { useDiscoverServices } from '../../../../../hooks/use_discover_services';
import { getChartSectionConfiguration } from './get_chart_section_configuration';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('@kbn/esql-utils', () => ({
  ...jest.requireActual('@kbn/esql-utils'),
  getESQLResults: jest.fn(),
}));

jest.mock('@kbn/data-plugin/public', () => ({
  getEsQueryConfig: jest.fn(() => ({})),
  getTime: jest.fn(() => undefined),
}));

jest.mock('../../../../../hooks/use_discover_services');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Abbreviated result type used when casting partial mock objects. */
type EsqlResult = Awaited<ReturnType<typeof getESQLResults>>;

/** Cast a partial mock response to the full EsqlResult type. */
const asResult = (val: {
  response: { values: Array<Array<string | number | null>> };
}): EsqlResult => val as unknown as EsqlResult;

const mockGetESQLResults = jest.mocked(getESQLResults);
const mockAddFilters = jest.fn();

const makeDataView = ({ hasLogLevel = true } = {}) => ({
  id: 'test-dv',
  getIndexPattern: () => 'logs-*',
  timeFieldName: '@timestamp',
  getFieldByName: (name: string) =>
    hasLogLevel && name === 'log.level' ? { name: 'log.level' } : undefined,
});

/** Absolute-timestamp fetchParams so dateMath resolves reliably in tests. */
const makeFetchParams = (
  overrides: Partial<UnifiedHistogramFetchParams> = {}
): UnifiedHistogramFetchParams =>
  ({
    dataView: makeDataView(),
    filters: [],
    timeRange: { from: '2025-01-01T00:00:00.000Z', to: '2025-01-01T01:00:00.000Z' },
    esqlVariables: [],
    lastReloadRequestTime: 0,
    ...overrides,
  } as unknown as UnifiedHistogramFetchParams);

const makeProps = (overrides: Partial<ChartSectionProps> = {}): ChartSectionProps => ({
  services: {
    data: { search: { search: jest.fn() } },
    uiSettings: { get: jest.fn() },
    storage: { get: jest.fn().mockReturnValue(null), set: jest.fn() },
  } as unknown as UnifiedHistogramServices,
  renderToggleActions: () => undefined,
  fetchParams: makeFetchParams(),
  fetch$: undefined as unknown as ChartSectionProps['fetch$'],
  isComponentVisible: true,
  isTabSelected: true,
  ...overrides,
});

interface ChartSectionConfig {
  renderChartSection: (props: ChartSectionProps) => React.ReactNode;
}
const getConfig = (): ChartSectionConfig => {
  const fn = getChartSectionConfiguration() as unknown as (
    p: unknown,
    q: unknown
  ) => () => ChartSectionConfig;
  return fn({}, {})();
};

const renderPanel = (overrides: Partial<ChartSectionProps> = {}) => {
  render(<>{getConfig().renderChartSection(makeProps(overrides))}</>);
};

/** Empty ES|QL result — no rows. */
const empty = asResult({ response: { values: [] } });

// The component fires up to 5 queries in this order:
// [0] changePointPromise
// [1] patternsPromise
// [2] crossPeriodPromise
// [3] outliersPromise
// [4] errorRatePromise (only when log.level field exists)
const mockAllEmpty = () => mockGetESQLResults.mockResolvedValue(empty);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('LogsInsightsPanel', () => {
  beforeEach(() => {
    jest.mocked(useDiscoverServices).mockReturnValue({
      data: { query: { filterManager: { addFilters: mockAddFilters } } },
      aiops: undefined,
    } as unknown as ReturnType<typeof useDiscoverServices>);

    mockGetESQLResults.mockClear();
    mockAllEmpty();
    mockAddFilters.mockClear();
  });

  // -------------------------------------------------------------------------
  // Loading / empty states
  // -------------------------------------------------------------------------

  it('shows a loading spinner while queries are in flight', () => {
    mockGetESQLResults.mockReturnValue(new Promise(() => {})); // never resolves

    renderPanel();

    expect(screen.getByText('Analysing logs\u2026')).toBeInTheDocument();
  });

  it('shows empty state when all queries return no data', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getAllByText('None detected').length).toBeGreaterThan(0));
  });

  // -------------------------------------------------------------------------
  // Visibility guard
  // -------------------------------------------------------------------------

  it('does not fire any queries when isComponentVisible is false', () => {
    renderPanel({ isComponentVisible: false });

    expect(mockGetESQLResults).not.toHaveBeenCalled();
  });

  it('fires queries when the panel becomes visible after being hidden', async () => {
    // Reuse the same config instance so the component identity is preserved across rerenders.
    const config = getConfig();

    const { rerender } = render(
      <>{config.renderChartSection(makeProps({ isComponentVisible: false }))}</>
    );

    expect(mockGetESQLResults).not.toHaveBeenCalled();

    rerender(<>{config.renderChartSection(makeProps({ isComponentVisible: true }))}</>);

    await waitFor(() => expect(mockGetESQLResults).toHaveBeenCalled());
  });

  // -------------------------------------------------------------------------
  // Change point callout
  // -------------------------------------------------------------------------

  it('shows overall rate spike callout with change point type and bucket time', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(
        asResult({ response: { values: [[100, '2025-01-01T00:30:00.000Z', 'spike']] } })
      ) // [0] change point
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/1 overall rate anomaly detected/i)).toBeInTheDocument()
    );
    // The callout body should include the human-readable type label.
    expect(screen.getByText(/Spike/)).toBeInTheDocument();
  });

  it('shows "Open log rate analysis" button inside the overall spike callout when aiops is available', async () => {
    jest.mocked(useDiscoverServices).mockReturnValue({
      data: { query: { filterManager: { addFilters: mockAddFilters } } },
      aiops: {
        LogRateAnalysisContentComponent: () => null,
        getPatternAnalysisAvailable: jest.fn(),
        PatternAnalysisComponent: () => null,
        ChangePointDetectionComponent: () => null,
      },
    } as unknown as ReturnType<typeof useDiscoverServices>);

    mockGetESQLResults
      .mockResolvedValueOnce(
        asResult({ response: { values: [[100, '2025-01-01T00:30:00.000Z', 'spike']] } })
      ) // [0] change point
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() => expect(screen.getByText('Open log rate analysis')).toBeInTheDocument());
  });

  // -------------------------------------------------------------------------
  // Error rate callout
  // -------------------------------------------------------------------------

  it('shows error rate spike callout with filter button when log.level exists', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] cross-period
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(
        asResult({ response: { values: [[5, '2025-01-01T00:30:00.000Z', 'spike']] } })
      ); // [4] error rate

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/1 error-rate anomaly detected/i)).toBeInTheDocument()
    );
    expect(screen.getByText('Filter to error logs')).toBeInTheDocument();
  });

  it('does not fire the error rate query when log.level is absent from the data view', async () => {
    renderPanel({
      fetchParams: makeFetchParams({
        dataView: makeDataView({
          hasLogLevel: false,
        }) as unknown as UnifiedHistogramFetchParams['dataView'],
      }),
    });

    await waitFor(() => expect(screen.getAllByText('None detected').length).toBeGreaterThan(0));

    // changePoint + patterns + crossPeriod + outliers + meanCount = 5
    // no errorRate, no patternErrorOutlier, no errorOutlierMeta
    expect(mockGetESQLResults).toHaveBeenCalledTimes(5);
  });

  // -------------------------------------------------------------------------
  // Pattern changes section
  // -------------------------------------------------------------------------

  it('shows "new" pattern change badge when a category appears only in the current period', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(
        asResult({
          response: {
            values: [
              [10, 'auth failure', 'current'],
              [0, 'background noise', 'previous'], // previous data exists so hasPreviousData = true
            ],
          },
        })
      ) // [2] cross-period
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText('Compared to previous period')).toBeInTheDocument()
    );
    expect(screen.getByText(/\u2191 new/)).toBeInTheDocument();
    expect(screen.getByText(/auth failure/)).toBeInTheDocument();
  });

  it('shows "spiked" pattern change badge when count more than doubles', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(
        asResult({
          response: {
            values: [
              [30, 'timeout error', 'current'],
              [10, 'timeout error', 'previous'],
            ],
          },
        })
      ) // [2] cross-period
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText('Compared to previous period')).toBeInTheDocument()
    );
    // 30/10 = 3x spike — RTL normalizes \u00a0 to a regular space so use \s
    expect(screen.getByText(/\u2191\s3x/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Outliers section
  // -------------------------------------------------------------------------

  it('shows rare event badges for outlier patterns', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] cross-period
      .mockResolvedValueOnce(asResult({ response: { values: [[1, 'disk io error burst']] } })) // [3] outliers
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() => expect(screen.getByText('Rare events')).toBeInTheDocument());
    expect(screen.getByText(/disk io error burst/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Top patterns section
  // -------------------------------------------------------------------------

  it('shows top pattern badges', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(asResult({ response: { values: [[500, 'http request completed']] } })) // [1] patterns
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() => expect(screen.getByText('Top log patterns')).toBeInTheDocument());
    expect(screen.getByText(/http request completed/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Drill-down: badge clicks
  // -------------------------------------------------------------------------

  it('applies a match filter when a top pattern badge is clicked', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(asResult({ response: { values: [[200, 'timeout connecting host']] } })) // [1] patterns
      .mockResolvedValue(empty);

    renderPanel();

    await waitFor(() => expect(screen.getByText(/timeout connecting host/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/timeout connecting host/));

    expect(mockAddFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          bool: expect.objectContaining({
            should: expect.arrayContaining([
              expect.objectContaining({
                match: expect.objectContaining({
                  message: expect.objectContaining({
                    query: 'timeout connecting host',
                    operator: 'and',
                    fuzziness: 0,
                  }),
                }),
              }),
            ]),
          }),
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Anomaly magnitude ratio
  // -------------------------------------------------------------------------

  it('shows magnitude ratio in change point callout when meanCount is available', async () => {
    // Default makeDataView has log.level → queries: [0] changePoint, [1] patterns,
    // [2] crossPeriod, [3] outliers, [4] errorRate, [5] patternErrorOutlier, [6] meanCount
    mockGetESQLResults
      .mockResolvedValueOnce(
        asResult({ response: { values: [[800, '2025-01-01T00:30:00.000Z', 'spike']] } })
      ) // [0] changePoint — record_count=800
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] crossPeriod
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(empty) // [4] errorRate
      .mockResolvedValueOnce(empty) // [5] patternErrorOutlier
      .mockResolvedValueOnce(asResult({ response: { values: [[100]] } })); // [6] meanCount = 100 → ratio 8×

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/1 overall rate anomaly detected/i)).toBeInTheDocument()
    );
    // ratio = 800/100 = 8 → should show "8× avg"
    expect(screen.getByText(/8×\s*avg/)).toBeInTheDocument();
  });

  it('does not show magnitude ratio when ratio is less than 2', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(
        asResult({ response: { values: [[110, '2025-01-01T00:30:00.000Z', 'spike']] } })
      ) // [0] changePoint — record_count=110, ratio ~1 → don't show
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(asResult({ response: { values: [[100]] } })); // meanCount=100

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/1 overall rate anomaly detected/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/avg/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Error-prone patterns section
  // -------------------------------------------------------------------------

  it('shows error-prone pattern badges when a pattern has a high error rate', async () => {
    // [5] patternErrorOutlier: "db timeout" with 50 errors / 100 total; "login ok" 0/900
    // fleet=50/1000=5%, "db timeout"=50/100=50% → 10× fleet → outlier
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] changePoint
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] crossPeriod
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(empty) // [4] errorRate
      .mockResolvedValueOnce(
        asResult({
          response: {
            values: [
              [50, 100, 'db timeout connecting host'],
              [0, 900, 'login ok'],
            ],
          },
        })
      ) // [5] patternErrorOutlier
      .mockResolvedValueOnce(empty); // [6] meanCount

    renderPanel();

    await waitFor(() => expect(screen.getByText('Error-prone patterns')).toBeInTheDocument());
    expect(screen.getByText(/db timeout connecting host/)).toBeInTheDocument();
    expect(screen.getByText(/50% errors/)).toBeInTheDocument();
  });

  it('applies a message filter when an error-prone pattern badge is clicked', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] changePoint
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] crossPeriod
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(empty) // [4] errorRate
      .mockResolvedValueOnce(
        asResult({
          response: {
            values: [
              [50, 100, 'db timeout connecting host'],
              [0, 900, 'login ok'],
            ],
          },
        })
      ) // [5] patternErrorOutlier
      .mockResolvedValueOnce(empty); // [6] meanCount

    renderPanel();

    await waitFor(() => expect(screen.getByText(/db timeout connecting host/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/db timeout connecting host/));

    expect(mockAddFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          bool: expect.objectContaining({
            should: expect.arrayContaining([
              expect.objectContaining({
                match: expect.objectContaining({
                  message: expect.objectContaining({
                    query: 'db timeout connecting host',
                    operator: 'and',
                  }),
                }),
              }),
            ]),
          }),
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Error outliers section
  // -------------------------------------------------------------------------

  it('shows error outlier badges when a cohort field value has a high error rate', async () => {
    // The component fires 6 queries when log.level exists and cohort fields exist.
    // [0] changePoint, [1] patterns, [2] crossPeriod, [3] outliers, [4] errorRate,
    // [5] errorOutlierMeta (one per cohort field — but makeDataView only has log.level,
    //     no service.name etc., so errorOutlierFields will be empty → no outlier queries).
    //
    // To test the outlier UI we need a data view that also has service.name.
    const dataViewWithService = {
      id: 'test-dv',
      getIndexPattern: () => 'logs-*',
      timeFieldName: '@timestamp',
      getFieldByName: (name: string) =>
        name === 'log.level' || name === 'service.name' ? { name } : undefined,
    };

    // With service.name present the component fires an extra errorOutlier query after
    // the 5 standard ones. mockGetESQLResults call order:
    // [0] changePoint, [1] patterns, [2] crossPeriod, [3] outliers, [4] errorRate,
    // [5] errorOutlier(service.name)
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] changePoint
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] crossPeriod
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(empty) // [4] errorRate
      // [5] errorOutlier(service.name): errors=50, total=100, value="bad-service"
      // fleet: only one row so fleetErrorRate = 50/100 = 50%, outlier errorRate = 50% → not > 2×
      // Use two rows so fleet rate is low enough: errors=50,total=100,"bad-service" + 0,900,"ok-service"
      // fleet=50/1000=5%, bad-service=50/100=50% → 50% > 10% threshold → outlier
      .mockResolvedValueOnce(
        asResult({
          response: {
            values: [
              [50, 100, 'bad-service'],
              [0, 900, 'ok-service'],
            ],
          },
        })
      );

    renderPanel({
      fetchParams: makeFetchParams({
        dataView: dataViewWithService as unknown as UnifiedHistogramFetchParams['dataView'],
      }),
    });

    await waitFor(() => expect(screen.getByText('Error outliers')).toBeInTheDocument());
    expect(screen.getByText(/bad-service/)).toBeInTheDocument();
    // The badge should show the percentage and ratio
    expect(screen.getByText(/50% errors/)).toBeInTheDocument();
  });

  it('applies term + log.level filters when an error outlier badge is clicked', async () => {
    const dataViewWithService = {
      id: 'test-dv',
      getIndexPattern: () => 'logs-*',
      timeFieldName: '@timestamp',
      getFieldByName: (name: string) =>
        name === 'log.level' || name === 'service.name' ? { name } : undefined,
    };

    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] changePoint
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] crossPeriod
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(empty) // [4] errorRate
      .mockResolvedValueOnce(
        asResult({
          response: {
            values: [
              [50, 100, 'bad-service'],
              [0, 900, 'ok-service'],
            ],
          },
        })
      );

    renderPanel({
      fetchParams: makeFetchParams({
        dataView: dataViewWithService as unknown as UnifiedHistogramFetchParams['dataView'],
      }),
    });

    await waitFor(() => expect(screen.getByText(/bad-service/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/bad-service/));

    // Should have called addFilters with an array containing both filters
    expect(mockAddFilters).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ query: { term: { 'service.name': 'bad-service' } } }),
        expect.objectContaining({
          query: { terms: { 'log.level': ['error', 'ERROR', 'critical', 'CRITICAL'] } },
        }),
      ])
    );
  });

  it('does not show error outliers section when no cohort field is in the data view', async () => {
    // makeDataView only has log.level — no service.name/host.name etc.
    renderPanel();

    await waitFor(() => expect(screen.getAllByText('None detected').length).toBeGreaterThan(0));
    // Error outliers section always renders, but shows no badge content when no cohort field
    expect(screen.getByText('Error outliers')).toBeInTheDocument();
    expect(screen.queryByText(/errors.*avg/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Drill-down: error rate filter button
  // -------------------------------------------------------------------------

  it('applies a terms filter for log.level when "Filter to error logs" is clicked', async () => {
    mockGetESQLResults
      .mockResolvedValueOnce(empty) // [0] change point
      .mockResolvedValueOnce(empty) // [1] patterns
      .mockResolvedValueOnce(empty) // [2] cross-period
      .mockResolvedValueOnce(empty) // [3] outliers
      .mockResolvedValueOnce(
        asResult({ response: { values: [[5, '2025-01-01T00:30:00.000Z', 'spike']] } })
      ); // [4] error rate

    renderPanel();

    await waitFor(() => expect(screen.getByText('Filter to error logs')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Filter to error logs'));

    expect(mockAddFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { terms: { 'log.level': ['error', 'ERROR', 'critical', 'CRITICAL'] } },
      })
    );
  });
});
