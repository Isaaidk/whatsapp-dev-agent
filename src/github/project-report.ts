import type { RepositoryContext } from './repository-context';

const MAX_REPORT_LENGTH = 4000;
const MAX_LIST_ITEMS = 12;

const ENTRY_POINT_CANDIDATES = [
  'src/server.ts',
  'src/index.ts',
  'src/main.ts',
  'src/app.ts',
  'index.ts',
  'index.js',
  'server.ts',
  'main.py',
  'app.py',
  'manage.py',
  'main.go',
  'cmd/main.go',
  'Program.cs',
  'Dockerfile',
  'docker-compose.yml',
  '.devcontainer/devcontainer.json',
];

const LOCK_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'go.sum'];

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readConfigurationFile(context: RepositoryContext, path: string): string | undefined {
  return context.configurationFiles.find((file) => file.path === path)?.content;
}

export function readPackageJson(context: RepositoryContext): Record<string, unknown> | undefined {
  const raw = readConfigurationFile(context, 'package.json');
  if (!raw) return undefined;
  try {
    return toRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function countFilesByExtension(context: RepositoryContext): Array<{ extension: string; count: number }> {
  const counters = new Map<string, number>();
  for (const entry of context.directoryTree) {
    if (entry.type !== 'blob') continue;
    const base = entry.path.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue;
    const extension = base.slice(dot).toLowerCase();
    counters.set(extension, (counters.get(extension) ?? 0) + 1);
  }
  return [...counters.entries()]
    .map(([extension, count]) => ({ extension, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, MAX_LIST_ITEMS);
}

export function topLevelEntries(context: RepositoryContext): Array<{ name: string; files: number }> {
  const counters = new Map<string, number>();
  for (const entry of context.directoryTree) {
    const head = entry.path.split('/')[0];
    if (!head) continue;
    if (head === entry.path && entry.type === 'tree') {
      counters.set(head, counters.get(head) ?? 0);
      continue;
    }
    counters.set(head, (counters.get(head) ?? 0) + (entry.type === 'blob' ? 1 : 0));
  }
  return [...counters.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name))
    .slice(0, MAX_LIST_ITEMS);
}

function formatPackageScripts(packageJson: Record<string, unknown> | undefined): string[] {
  const scripts = toRecord(packageJson?.scripts);
  if (!scripts) return [];
  return Object.entries(scripts).map(([name, command]) => `- ${name}: ${String(command)}`);
}

function formatDependencies(packageJson: Record<string, unknown> | undefined): string[] {
  const dependencies = toRecord(packageJson?.dependencies) ?? {};
  const devDependencies = toRecord(packageJson?.devDependencies) ?? {};
  const names = Object.keys(dependencies);
  const lines: string[] = [];
  if (names.length > 0) {
    lines.push(`- Producción (${names.length}): ${names.slice(0, MAX_LIST_ITEMS).join(', ')}${names.length > MAX_LIST_ITEMS ? '…' : ''}`);
  }
  const devNames = Object.keys(devDependencies);
  if (devNames.length > 0) {
    lines.push(`- Desarrollo (${devNames.length}): ${devNames.slice(0, MAX_LIST_ITEMS).join(', ')}${devNames.length > MAX_LIST_ITEMS ? '…' : ''}`);
  }
  return lines;
}

function inferExecutionCommands(packageJson: Record<string, unknown> | undefined): string[] {
  const scripts = toRecord(packageJson?.scripts) ?? {};
  const interesting = ['install', 'dev', 'start', 'build', 'test', 'lint'];
  const commands = interesting
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => `- ${name === 'install' ? 'Instalar' : `Ejecutar ${name}`}: ${String(scripts[name])}`);
  if (commands.length === 0) commands.push('- No hay scripts de npm declarados.');
  return commands;
}

export function detectObservableRisks(context: RepositoryContext): string[] {
  const paths = new Set(context.directoryTree.map((entry) => entry.path));
  const risks: string[] = [];
  if (context.detected.tests.length === 0) risks.push('No se detectaron pruebas automatizadas.');
  const hasCi = [...paths].some((path) => path.startsWith('.github/workflows/'));
  if (!hasCi) risks.push('No se detectaron flujos de CI en .github/workflows.');
  if (!context.readme) risks.push('No se pudo leer un README.');
  if (!LOCK_FILES.some((lock) => paths.has(lock))) risks.push('No se detectó un archivo de bloqueo de dependencias (lockfile).');
  if (!paths.has('.env.example')) risks.push('No hay .env.example, así que la configuración esperada no está documentada.');
  if (!paths.has('Dockerfile') && !paths.has('.devcontainer/devcontainer.json')) risks.push('No hay Dockerfile ni devcontainer.');
  return risks;
}

export function detectEntryPoints(context: RepositoryContext): string[] {
  const paths = new Set(context.directoryTree.map((entry) => entry.path));
  const found = ENTRY_POINT_CANDIDATES.filter((candidate) => paths.has(candidate));
  const packageJson = readPackageJson(context);
  const main = typeof packageJson?.main === 'string' ? packageJson.main : undefined;
  if (main && paths.has(main) && !found.includes(main)) found.unshift(main);
  return found;
}

/**
 * Genera un informe determinista de cómo está construido un proyecto usando
 * únicamente datos reales obtenidos de GitHub. No depende de ningún modelo.
 */
export function buildProjectReport(context: RepositoryContext): string {
  const { repository, detected } = context;
  const packageJson = readPackageJson(context);
  const openPullRequests = context.recentActivity.pullRequests.length;
  const sections: string[] = [];

  sections.push([
    `Informe del proyecto ${repository.owner}/${repository.name}`,
    `Descripción: ${repository.description ?? 'sin descripción'}`,
    `Lenguaje principal: ${repository.language ?? 'no indicado'}`,
    `Visibilidad: ${repository.visibility ?? 'desconocida'}`,
    `Rama por defecto: ${repository.defaultBranch}`,
  ].join('\n'));

  sections.push([
    'Stack detectado',
    `- ${detected.stack.length > 0 ? detected.stack.join(', ') : 'no identificado'}`,
    `- Archivos rastreados: ${context.directoryTree.filter((entry) => entry.type === 'blob').length}`,
  ].join('\n'));

  const topLevel = topLevelEntries(context);
  sections.push([
    'Estructura de primer nivel',
    ...(topLevel.length > 0
      ? topLevel.map((entry) => `- ${entry.name}${entry.files > 0 ? ` (${entry.files} archivos)` : ''}`)
      : ['- Sin datos del árbol de archivos.']),
  ].join('\n'));

  const extensions = countFilesByExtension(context);
  sections.push([
    'Tipos de archivo más frecuentes',
    ...(extensions.length > 0
      ? extensions.map((entry) => `- ${entry.extension}: ${entry.count}`)
      : ['- Sin datos suficientes.']),
  ].join('\n'));

  const entryPoints = detectEntryPoints(context);
  sections.push([
    'Puntos de entrada y contenedores',
    ...(entryPoints.length > 0 ? entryPoints.map((path) => `- ${path}`) : ['- No se identificaron puntos de entrada habituales.']),
  ].join('\n'));

  const scripts = formatPackageScripts(packageJson);
  if (scripts.length > 0) {
    sections.push(['Scripts declarados', ...scripts].join('\n'));
  }

  const dependencies = formatDependencies(packageJson);
  if (dependencies.length > 0) {
    sections.push(['Dependencias', ...dependencies].join('\n'));
  }

  if (packageJson) {
    sections.push(['Cómo se ejecuta', ...inferExecutionCommands(packageJson)].join('\n'));
  }

  sections.push([
    'Pruebas y documentación',
    `- Archivos de prueba detectados: ${detected.tests.length}`,
    `- Documentos detectados: ${context.documentation.length}`,
    `- Issues abiertos: ${context.recentActivity.issues.length}`,
    `- Pull requests abiertos: ${openPullRequests}`,
  ].join('\n'));

  const risks = detectObservableRisks(context);
  sections.push([
    'Riesgos observados',
    ...(risks.length > 0 ? risks.map((risk) => `- ${risk}`) : ['- No se detectaron riesgos evidentes en los datos disponibles.']),
  ].join('\n'));

  const report = sections.join('\n\n');
  return report.length > MAX_REPORT_LENGTH
    ? `${report.slice(0, MAX_REPORT_LENGTH)}\n\n[informe truncado]`
    : report;
}
