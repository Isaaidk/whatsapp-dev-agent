import { env } from '../config/env';

export enum Capability {
  READ_REPOSITORY = 'READ_REPOSITORY',
  READ_FILES = 'READ_FILES',
  READ_ISSUES = 'READ_ISSUES',
  READ_PULL_REQUESTS = 'READ_PULL_REQUESTS',
  ANALYZE_REPOSITORY = 'ANALYZE_REPOSITORY',
  WRITE_FILES = 'WRITE_FILES',
  CREATE_BRANCH = 'CREATE_BRANCH',
  COMMIT = 'COMMIT',
  CREATE_PR = 'CREATE_PR',
  DEPLOY = 'DEPLOY',
}

export const READ_ONLY_CAPABILITIES = new Set<Capability>([
  Capability.READ_REPOSITORY,
  Capability.READ_FILES,
  Capability.READ_ISSUES,
  Capability.READ_PULL_REQUESTS,
  Capability.ANALYZE_REPOSITORY,
]);

export const WRITE_CAPABILITIES = new Set<Capability>([
  Capability.WRITE_FILES,
  Capability.CREATE_BRANCH,
  Capability.COMMIT,
  Capability.CREATE_PR,
]);

export class PermissionError extends Error {
  constructor(capability: Capability) {
    super(`La capacidad ${capability} no está habilitada en esta fase.`);
    this.name = 'PermissionError';
  }
}

/** Capacidades de escritura concedidas temporalmente tras una aprobación explícita. */
const grantedCapabilities = new Set<Capability>();

export function isWriteEnabled(): boolean {
  return env.allowWriteOperations;
}

/**
 * Concede capacidades de escritura al flujo en curso. Los llamadores deben
 * revocarlas en un bloque `finally`.
 */
export function grantWriteCapabilities(): void {
  for (const capability of WRITE_CAPABILITIES) grantedCapabilities.add(capability);
}

export function revokeWriteCapabilities(): void {
  grantedCapabilities.clear();
}

export function isCapabilityEnabled(capability: Capability): boolean {
  if (READ_ONLY_CAPABILITIES.has(capability)) return true;
  if (!env.allowWriteOperations) return false;
  return grantedCapabilities.has(capability);
}

export function assertCapability(capability: Capability): void {
  if (!isCapabilityEnabled(capability)) {
    throw new PermissionError(capability);
  }
}