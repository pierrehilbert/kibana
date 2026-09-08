/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AppMountParameters, CoreStart } from '@kbn/core/public';
import { APP_WRAPPER_CLASS } from '@kbn/core/public';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-browser';
import { KibanaRenderContextProvider } from '@kbn/react-kibana-context-render';
import React from 'react';
import ReactDOM from 'react-dom';
import { LogsAiApp } from './app';

interface RenderAppProps {
  core: CoreStart;
  agentBuilder: AgentBuilderPluginStart;
  params: AppMountParameters;
}

export function renderApp({ core, agentBuilder, params }: RenderAppProps) {
  const { element, theme$ } = params;

  ReactDOM.render(
    <KibanaRenderContextProvider {...core} theme={{ theme$ }}>
      <div className={APP_WRAPPER_CLASS} style={{ height: '100%' }}>
        <LogsAiApp agentBuilder={agentBuilder} />
      </div>
    </KibanaRenderContextProvider>,
    element
  );

  return () => ReactDOM.unmountComponentAtNode(element);
}
