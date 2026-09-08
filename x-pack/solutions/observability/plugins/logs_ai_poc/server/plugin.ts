/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext, Logger } from '@kbn/core/server';
import { z } from 'zod';
import { ToolType } from '@kbn/agent-builder-common';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupDeps {
  agentBuilder: AgentBuilderPluginSetup;
}

// ─── Skill content ────────────────────────────────────────────────────────────

const SKILL_CONTENT = `# Logs Investigation

**IMPORTANT: When the user asks anything about logs, log levels, error rates, services, or log anomalies, you MUST use \`logs_ai_poc.get_logs\` and NOT \`platform.core.search\` or any other search tool.**

\`logs_ai_poc.get_logs\` is purpose-built for log investigation: it returns pre-aggregated histograms, top field values, and raw samples in one call — far more efficient than a generic search.

## When to use \`logs_ai_poc.get_logs\`
- Any question about log volume, error rates, or anomalies
- Any question mentioning a service name, log level, or time window
- Any question about what is happening or failing in the system

## Workflow
1. Start broad — no \`kqlFilter\` — to see the overall landscape
2. Check \`topValues\` for dominant log levels / services; look for spikes in \`histogram\`
3. Narrow down with a \`kqlFilter\` (e.g. \`log.level: ERROR\`) and optionally a \`groupBy\`

## Tool result fields
- \`totalCount\`: total matching documents
- \`histogram\`: time-series buckets (with optional group breakdown when \`groupBy\` is set)
- \`topValues\`: top values for \`log.level\` and \`service.name\`
- \`samples\`: recent raw log documents

## Response format
Always cite real numbers from the result:
- What the data shows (counts, trends)
- Key patterns or anomalies (spikes, dominant error types)
- Top offenders (services, log levels)
- Suggested follow-up queries`;

// ─── ES query ─────────────────────────────────────────────────────────────────

async function fetchLogsData({
  esClient,
  logger,
  kqlFilter,
  groupBy,
  start = 'now-2h',
  end = 'now',
}: {
  esClient: any;
  logger: Logger;
  kqlFilter?: string;
  groupBy?: string;
  start?: string;
  end?: string;
}) {
  const query: Record<string, unknown> = {
    bool: {
      filter: [{ range: { '@timestamp': { gte: start, lte: end } } }],
    },
  };

  if (kqlFilter?.trim()) {
    (query.bool as any).must = [{ query_string: { query: kqlFilter } }];
  }

  const result = await esClient.search({
    index: 'logs-*',
    size: 20,
    fields: ['*'],
    _source: true,
    sort: [{ '@timestamp': { order: 'desc' } }],
    query,
    aggs: {
      histogram: {
        date_histogram: {
          field: '@timestamp',
          fixed_interval: '5m',
          min_doc_count: 0,
        },
        ...(groupBy
          ? { aggs: { groups: { terms: { field: groupBy, size: 5 } } } }
          : {}),
      },
      by_level: { terms: { field: 'log.level', size: 5 } },
      by_service: { terms: { field: 'service.name', size: 10 } },
    },
  });

  const aggs = result.aggregations as any;
  const totalCount =
    typeof result.hits.total === 'number'
      ? result.hits.total
      : (result.hits.total?.value ?? 0);

  const histogram = (aggs?.histogram?.buckets ?? []).map((b: any) => ({
    bucket: b.key_as_string as string,
    count: b.doc_count as number,
    ...(b.groups
      ? {
          groups: (b.groups.buckets as any[]).map((g) => ({
            key: String(g.key),
            count: g.doc_count as number,
          })),
        }
      : {}),
  }));

  const hits: any[] = result.hits.hits ?? [];
  const samples = hits.map((h: any) => {
    if (h._source && Object.keys(h._source).length > 0) return h._source;
    if (h.fields) {
      return Object.fromEntries(
        Object.entries(h.fields as Record<string, unknown[]>).map(([k, v]) => [
          k,
          Array.isArray(v) && v.length === 1 ? v[0] : v,
        ])
      );
    }
    return { _id: h._id, _index: h._index };
  });

  logger.debug(`[logs_ai_poc] get_logs: total=${totalCount} samples=${samples.length}`);

  return {
    totalCount,
    histogram,
    topValues: {
      'log.level': (aggs?.by_level?.buckets ?? []).map((b: any) => ({
        value: String(b.key),
        count: b.doc_count as number,
      })),
      'service.name': (aggs?.by_service?.buckets ?? []).map((b: any) => ({
        value: String(b.key),
        count: b.doc_count as number,
      })),
    },
    samples,
  };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class LogsAiPocPlugin implements Plugin<{}, {}, SetupDeps, {}> {
  private readonly logger: Logger;

  constructor(initContext: PluginInitializerContext) {
    this.logger = initContext.logger.get();
  }

  setup(_core: CoreSetup, { agentBuilder }: SetupDeps) {
    const logger = this.logger;

    // ── Register get_logs tool ────────────────────────────────────────────────
    agentBuilder.tools.register({
      type: ToolType.builtin,
      id: 'logs_ai_poc.get_logs',
      name: 'Get Logs',
      description: `Fetch log data from Elasticsearch logs-* indices.
Preferred over generic search for ALL log investigation tasks.
Returns a time-series histogram, total document count, top field values (log.level, service.name), and recent raw log samples in a single efficient call.

Use this (not platform.core.search) whenever the user asks about:
- Log volume, error rates, or anomaly detection
- A specific service, log level, or time window
- What is happening or failing in the system`,
      schema: z.object({
        kqlFilter: z
          .string()
          .optional()
          .describe(
            'KQL filter to narrow results. Build iteratively. E.g. "service.name: checkout AND log.level: ERROR"'
          ),
        groupBy: z
          .string()
          .optional()
          .describe('Field to split the histogram by. E.g. "log.level" or "service.name"'),
        start: z.string().optional().describe('Start time (ISO 8601 or datemath). Default: now-2h'),
        end: z.string().optional().describe('End time (ISO 8601 or datemath). Default: now'),
      }),
      handler: async ({ kqlFilter, groupBy, start, end }, context) => {
        const logsData = await fetchLogsData({
          esClient: context.esClient.asCurrentUser,
          logger,
          kqlFilter,
          groupBy,
          start,
          end,
        });
        return {
          results: [{ type: 'other' as const, data: logsData }],
        };
      },
    });

    // ── Register skill (auto-included in any agent with enable_elastic_capabilities) ─
    agentBuilder.skills.register({
      id: 'logs-ai-poc-investigation',
      name: 'logs-ai-poc-investigation',
      basePath: 'skills/observability/logs',
      description:
        'Investigate logs from Elasticsearch: error rates, service health, anomalies, and raw log samples.',
      content: SKILL_CONTENT,
      getRegistryTools: () => ['logs_ai_poc.get_logs'],
    });

    return {};
  }

  start(_core: CoreStart): {} {
    return {};
  }
}
