import type { CapabilityModule } from '../types';

export const messagingModule: CapabilityModule = {
  name: 'messaging',
  async handle(): Promise<string> {
    return 'El módulo de mensajería todavía no está habilitado.';
  },
};