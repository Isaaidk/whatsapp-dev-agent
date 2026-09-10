import type { CapabilityModule } from '../types';

export const voiceModule: CapabilityModule = {
  name: 'voice',
  async handle(): Promise<string> {
    return 'El módulo de voz todavía no está habilitado.';
  },
};