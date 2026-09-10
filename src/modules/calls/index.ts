import type { CapabilityModule } from '../types';

export const callsModule: CapabilityModule = {
  name: 'calls',
  async handle(): Promise<string> {
    return 'El módulo de llamadas todavía no está habilitado.';
  },
};