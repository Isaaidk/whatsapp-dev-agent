import type { CapabilityModule } from '../types';

export const musicModule: CapabilityModule = {
  name: 'music',
  async handle(): Promise<string> {
    return 'El módulo de música todavía no está habilitado.';
  },
};