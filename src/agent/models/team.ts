import type { ModelGenerationRequest, ModelProvider } from './provider';

export type AgentRole = 'interpreter' | 'planner' | 'coder' | 'reviewer';

export interface ModelTeam {
  generate(role: AgentRole, request: ModelGenerationRequest): Promise<string>;
}

export class SingleProviderModelTeam implements ModelTeam {
  constructor(private readonly provider: ModelProvider) {}

  generate(_role: AgentRole, request: ModelGenerationRequest): Promise<string> {
    return this.provider.generate(request);
  }
}