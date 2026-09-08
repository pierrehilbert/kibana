/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-browser';

export function LogsAiApp({ agentBuilder }: { agentBuilder: AgentBuilderPluginStart }) {
  const { EmbeddableConversation } = agentBuilder;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <EmbeddableConversation
        agentId="logs_ai_poc.logs_investigator"
        sessionTag="logs-ai-poc"
        greetingMessage="I'm your Logs AI Investigator. Ask me about error trends, service health, or anything in your logs."
      />
    </div>
  );
}
