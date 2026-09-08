/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AppMountParameters, CoreSetup, CoreStart, Plugin } from '@kbn/core/public';
import { DEFAULT_APP_CATEGORIES } from '@kbn/core/public';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-browser';

interface StartDeps {
  agentBuilder: AgentBuilderPluginStart;
}

export class LogsAiPocPublicPlugin implements Plugin<void, void, {}, StartDeps> {
  setup(core: CoreSetup<StartDeps>) {
    core.application.register({
      id: 'logsAiPoc',
      title: 'Logs AI Investigator',
      euiIconType: 'logoObservability',
      category: DEFAULT_APP_CATEGORIES.observability,
      visibleIn: ['globalSearch'],
      async mount(params: AppMountParameters) {
        const [{ renderApp }, [coreStart, startPlugins]] = await Promise.all([
          import('./application'),
          core.getStartServices(),
        ]);
        return renderApp({ core: coreStart, agentBuilder: startPlugins.agentBuilder, params });
      },
    });
  }

  start(_core: CoreStart): void {}
}
