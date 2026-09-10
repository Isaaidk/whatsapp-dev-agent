import { describe, expect, it } from 'vitest';
import type { RepositoryContext } from '../src/github/repository-context';
import {
  buildProjectReport,
  countFilesByExtension,
  detectEntryPoints,
  detectObservableRisks,
  topLevelEntries,
} from '../src/github/project-report';

function createContext(overrides: Partial<RepositoryContext> = {}): RepositoryContext {
  return {
    repository: {
      name: 'app',
      owner: 'acme',
      defaultBranch: 'main',
      description: 'App de prueba',
      language: 'TypeScript',
      visibility: 'private',
    },
    readme: '# App',
    directoryTree: [
      { path: 'src', type: 'tree' },
      { path: 'src/server.ts', type: 'blob' },
      { path: 'src/agent/agent.ts', type: 'blob' },
      { path: 'tests/webhook.test.ts', type: 'blob' },
      { path: '.github/workflows/ci.yml', type: 'blob' },
      { path: 'package.json', type: 'blob' },
      { path: 'package-lock.json', type: 'blob' },
      { path: '.env.example', type: 'blob' },
      { path: 'Dockerfile', type: 'blob' },
    ],
    configurationFiles: [
      {
        path: 'package.json',
        content: JSON.stringify({
          main: 'src/server.ts',
          scripts: { dev: 'tsx watch src/server.ts', build: 'tsc', test: 'vitest run' },
          dependencies: { express: '^4.21.2' },
          devDependencies: { typescript: '^5.7.2' },
        }),
      },
    ],
    documentation: ['README.md'],
    recentActivity: { issues: [], pullRequests: [] },
    detected: { stack: ['TypeScript', 'Node.js'], tests: ['tests/webhook.test.ts'] },
    source: 'github',
    ...overrides,
  };
}

describe('buildProjectReport', () => {
  it('describe la ficha del proyecto con datos reales', () => {
    const report = buildProjectReport(createContext());

    expect(report).toContain('Informe del proyecto acme/app');
    expect(report).toContain('Descripción: App de prueba');
    expect(report).toContain('Lenguaje principal: TypeScript');
    expect(report).toContain('Rama por defecto: main');
    expect(report).toContain('Archivos de prueba detectados: 1');
  });

  it('incluye puntos de entrada, scripts y dependencias', () => {
    const report = buildProjectReport(createContext());

    expect(report).toContain('src/server.ts');
    expect(report).toContain('dev: tsx watch src/server.ts');
    expect(report).toContain('Producción (1): express');
    expect(report).toContain('Desarrollo (1): typescript');
    expect(report).toContain('Ejecutar test: vitest run');
  });

  it('trunca el informe cuando es muy largo', () => {
    const report = buildProjectReport(
      createContext({
        configurationFiles: [
          {
            path: 'package.json',
            content: JSON.stringify({
              scripts: Object.fromEntries(
                Array.from({ length: 200 }, (_, index) => [`script-${index}`, `comando-${index}`]),
              ),
            }),
          },
        ],
      }),
    );

    expect(report.length).toBeLessThanOrEqual(4000 + '\n\n[informe truncado]'.length);
    expect(report).toContain('[informe truncado]');
  });

  it('no falla si no hay package.json legible', () => {
    const report = buildProjectReport(
      createContext({ configurationFiles: [{ path: 'package.json', content: '{ roto' }] }),
    );

    expect(report).toContain('Informe del proyecto');
    expect(report).not.toContain('Dependencias');
  });
});

describe('detectObservableRisks', () => {
  it('no reporta riesgos cuando hay tests, CI, README, lockfile y Dockerfile', () => {
    expect(detectObservableRisks(createContext())).toEqual([]);
  });

  it('reporta la falta de tests, CI, README, lockfile y devcontainer', () => {
    const risks = detectObservableRisks(
      createContext({
        readme: undefined,
        directoryTree: [{ path: 'src/index.ts', type: 'blob' }],
        detected: { stack: ['TypeScript'], tests: [] },
      }),
    );

    expect(risks).toContain('No se detectaron pruebas automatizadas.');
    expect(risks).toContain('No se detectaron flujos de CI en .github/workflows.');
    expect(risks).toContain('No se pudo leer un README.');
    expect(risks).toContain('No se detectó un archivo de bloqueo de dependencias (lockfile).');
    expect(risks).toContain('No hay .env.example, así que la configuración esperada no está documentada.');
    expect(risks).toContain('No hay Dockerfile ni devcontainer.');
  });
});

describe('helpers del informe', () => {
  it('cuenta archivos por extensión ordenados por frecuencia', () => {
    expect(countFilesByExtension(createContext())[0]).toEqual({ extension: '.ts', count: 3 });
  });

  it('agrupa el árbol por carpeta de primer nivel', () => {
    expect(topLevelEntries(createContext())).toContainEqual({ name: 'src', files: 2 });
  });

  it('prioriza el campo main del package.json como punto de entrada', () => {
    const entryPoints = detectEntryPoints(
      createContext({
        configurationFiles: [{ path: 'package.json', content: JSON.stringify({ main: 'dist/index.js' }) }],
      }),
    );

    expect(entryPoints).toContain('Dockerfile');
    expect(entryPoints).toContain('src/server.ts');
    expect(entryPoints).not.toContain('dist/index.js');
  });
});
