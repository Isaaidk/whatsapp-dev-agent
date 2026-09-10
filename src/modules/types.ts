import type { AgentContext } from '../agent/context';

export interface CapabilityRequest {
  userId: string;
  input: string;
  context: AgentContext;
}

export interface CapabilityModule {
  readonly name: string;
  handle(request: CapabilityRequest): Promise<string>;
}