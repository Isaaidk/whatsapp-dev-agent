import type { CapabilityModule } from '../types';

export const networkModule: CapabilityModule = {
  name: 'network',
  async handle(): Promise<string> {
    return 'El módulo de administración de red todavía no está habilitado.';
  },
};