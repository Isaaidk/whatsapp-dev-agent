import type { IncomingMessage } from '../channels/types';
import type { AgentContext } from './context';
import type { ModelRouter } from './models/router';
import { repositoryContextFacts } from '../github/repository-context';
import { buildProjectReport } from '../github/project-report';
import { RepositoryManager } from '../github/repository-manager';
import {
  PermissionError,
  grantWriteCapabilities,
  isWriteEnabled,
  revokeWriteCapabilities,
} from '../github/permissions';
import { GitHubClientError, type GitHubRepository } from '../github/types';
import type { WorkspaceProvider } from '../workspace/types';
import type { WorkspaceExecutionResult, WorkspaceRunner } from '../workspace/runner';
import { buildAgentBranch, commitAndPush, describeGitError, GitOperationError } from '../workspace/git-operations';
import { prepareWorkspace } from '../workspace/workspace-preparation';
import { runDeepSeekCodingTask } from '../workspace/deepseek-coder';
import { AgentJobRegistry, describeError, type JobContext } from './jobs';
import { codespaceWorkdirFor, env, isDeepSeekConfigured } from '../config/env';
import { shellQuote } from '../workspace/gh-cli-runner';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GENERIC_ANALYSIS_TARGETS = new Set([
  'el proyecto',
  'el repositorio',
  'el repo',
  'este proyecto',
  'este repositorio',
  'mi proyecto',
  'la estructura',
  'el codigo',
  'el código',
]);

function isGenericAnalysisTarget(value: string): boolean {
  return GENERIC_ANALYSIS_TARGETS.has(value.trim().toLowerCase());
}

const PUBLISH_ALIASES = new Set([
  'aceptarcambiosysubiragthub',
  'aceptarcambiosysubiragithub',
  'aceptarcambiosysubiragit',
  'aceptarcambiosysubir',
  'aceptarcambiosypublicar',
  'publicarcambios',
  'subircambios',
  '/subir',
  '/push',
  '/publicar',
]);

/** Reconoce el comando de publicar cambios con sus variantes naturales. */
export function isPublishCommand(compact: string): boolean {
  if (PUBLISH_ALIASES.has(compact)) return true;
  return /cambio/.test(compact) && /(subir|sube|publicar|publica|push)/.test(compact);
}

function tail(text: string, limit = 1500): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `…\n${trimmed.slice(-limit)}`;
}

export class Orchestrator {
  private contextPersister?: (context: AgentContext) => void;

  constructor(
    private readonly repositoryManager: RepositoryManager | undefined,
    private readonly modelRouter: ModelRouter,
    private readonly workspaceProvider?: WorkspaceProvider,
    private readonly workspaceRunner?: WorkspaceRunner,
    private readonly jobs: AgentJobRegistry = new AgentJobRegistry(),
  ) {}

  /** Permite al agente persistir los cambios de contexto que ocurren en segundo plano. */
  setContextPersister(persister: (context: AgentContext) => void): void {
    this.contextPersister = persister;
  }

  private persistContext(context: AgentContext): void {
    try {
      this.contextPersister?.(context);
    } catch (error) {
      console.error('No pude persistir el contexto:', describeError(error));
    }
  }

  async handleMessage(message: IncomingMessage, context: AgentContext): Promise<string | undefined> {
    const command = message.text.trim();
    const normalized = command.toLowerCase();
    const compact = normalized.replace(/[\s_-]/g, '');
    const naturalSelection = command.match(/^quiero\s+trabajar\s+en\s+(.+)$/i);
    const analysis = command.match(/^\/?(?:analiza|analizar)(?:\s+(?:el\s+)?(?:repositorio|repo|proyecto))?(?:\s+(.+))?$/i);
    const file = command.match(/^\/(?:file|archivo)\s+(.+)$/i);
    const analysisQuestion = /\b(analiza|analizar|informe|estructura|lenguaje|tecnolog[ií]a|arquitectura|de qu[eé] trata|c[oó]mo est[aá] estructurad[oa]|c[oó]mo est[aá] construid[oa]|ficha del proyecto)\b/i.test(command);
    const changeRequest = /\b(modifica|modificar|cambia|cambiar|actualiza|actualizar|implementa|implementar|corrige|corregir|agrega|agregar|crea|crear|elimina|eliminar)\b/i.test(command);

    if (normalized === '/start') {
      return 'Hola. Soy tu asistente de desarrollo. Usa /habilidades para ver lo que puedo hacer, /repos para listar tus repositorios y /repo <nombre> para seleccionar uno.';
    }
    if (normalized === '/list' || normalized === '/lista') return this.commandList();
    if (normalized === '/help' || normalized === '/ayuda') return this.help();
    if (normalized === '/habilidades' || normalized === '/capacidades') return this.capabilities();
    if (normalized === '/repos') return this.listRepositories();
    if (normalized === '/repo') return this.currentRepository(context);
    if (normalized.startsWith('/repo ')) return this.selectRepository(command.slice(6).trim(), context);
    if (normalized === '/repo-status' || normalized === '/estado-repo') return this.repositoryStatus(context);
    if (normalized === '/branches' || normalized === '/ramas') return this.listBranches(context);
    if (normalized === '/issues') return this.listIssues(context);
    if (normalized === '/prs' || normalized === '/pulls') return this.listPullRequests(context);
    if (normalized === '/readme') return this.readFile(context, 'README.md');
    if (file) return this.readFile(context, file[1].trim());
    if (normalized === '/context') return this.describeContext(context);
    if (normalized === '/status') return this.status(context);
    if (normalized === '/plan') return this.pendingPlan(context);
    if (isPublishCommand(compact)) return this.publishChanges(message, context);
    if (compact === 'aceptarcambios') return this.approvePlan(message, context);
    if (normalized === '/aceptar' || normalized === '/aprobar') return this.approvePlan(message, context);
    if (normalized === '/cancelar') return this.cancelPlan(context);
    if (normalized === '/review' || normalized === '/revisar') return this.reviewChanges(context);
    if (normalized === '/codespace') return this.createCodespace(context);
    if (naturalSelection) return this.selectRepository(naturalSelection[1].trim(), context);
    if (analysis || analysisQuestion) {
      const capturedName = analysis?.[1]?.trim();
      const requestedRepository = capturedName && !isGenericAnalysisTarget(capturedName) ? capturedName : undefined;
      return this.analyzeRepository(requestedRepository, context);
    }
    if (changeRequest) return this.createChangePlan(command, context);
    return undefined;
  }

  private async listRepositories(): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const repositories = await this.repositoryManager.listRepositories();
      if (repositories.length === 0) return 'No hay repositorios autorizados en esta instalación de GitHub App.';
      return `Estos son tus repositorios disponibles:\n\n${repositories.map((repository, index) => `${index + 1}. ${repository.name}`).join('\n')}`;
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private async selectRepository(name: string, context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const repository = await this.repositoryManager.selectRepository(name, context);
      return [
        'Repositorio seleccionado:',
        '',
        repository.fullName,
        '',
        `Branch principal: ${repository.defaultBranch}`,
        `Lenguaje: ${repository.language ?? 'No indicado'}`,
        '',
        '¿Quieres que analice el repositorio?',
      ].join('\n');
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private currentRepository(context: AgentContext): string {
    if (!context.currentRepository) return 'No hay ningún repositorio seleccionado. Usa /repos o /repo <nombre>.';
    return `Repositorio actual: ${context.currentRepository}\nBranch: ${context.selectedBranch ?? 'No indicada'}`;
  }

  private async repositoryStatus(context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const status = await this.repositoryManager.getStatus(context);
      return [
        `Estado de ${status.repository.fullName}:`,
        `Descripción: ${status.repository.description ?? 'Sin descripción'}`,
        `Visibilidad: ${status.repository.private ? 'privado' : 'público'}`,
        `Lenguaje: ${status.repository.language ?? 'No indicado'}`,
        `Branch principal: ${status.branch.name}`,
        `Branch protegida: ${status.branch.protected ? 'sí' : 'no'}`,
        `Issues abiertos: ${status.openIssues}`,
        `Pull requests abiertos: ${status.openPullRequests}`,
        `Branches: ${status.recentBranches.map((branch) => branch.name).join(', ') || 'ninguna'}`,
      ].join('\n');
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private async listBranches(context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const status = await this.repositoryManager.getStatus(context);
      return `Branches de ${status.repository.fullName}:\n\n${status.recentBranches.map((branch) => `- ${branch.name}${branch.protected ? ' (protegida)' : ''}`).join('\n')}`;
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private help(): string {
    return this.commandList();
  }

  private commandList(): string {
    return [
      'Lista de comandos',
      '',
      '/start: iniciar el asistente',
      '/list: mostrar esta lista',
      '/habilidades: ver capacidades actuales',
      '/repos: listar repositorios de GitHub',
      '/repo nombre: seleccionar un repositorio',
      '/repo-status: ver el estado del repositorio actual',
      '/branches: listar ramas',
      '/readme: leer el README',
      '/file ruta: leer un archivo',
      '/issues: listar issues abiertos',
      '/prs: listar pull requests abiertos',
      '/context: ver el contexto cargado',
      '/analiza: informe de cómo está construido el repositorio seleccionado',
      '/status: ver el estado del agente',
      '/plan: ver el plan de cambio pendiente',
      '/aceptar: implementar el plan pendiente en el Codespace',
      '/cancelar: cancelar el plan pendiente',
      '/review: pedir al agente una revisión de los cambios',
      '/codespace: crear un Codespace para el repositorio actual',
      '',
      'Para subir cambios a GitHub escribe exactamente:',
      'aceptarcambiosysubiragthub',
      'Eso hace add, commit y push de los cambios del repositorio seleccionado.',
      '',
      'Para pedir un cambio, escribe por ejemplo: actualiza la documentación del proyecto. Primero recibirás un plan y una propuesta de cambios.',
    ].join('\n');
  }

  private capabilities(): string {
    return [
      'Habilidades actuales:',
      'Listar y seleccionar repositorios GitHub.',
      'Consultar estado, ramas, README, archivos, issues y pull requests.',
      `Analizar propósito, lenguaje, stack, estructura, tests y riesgos${isWriteEnabled() ? '' : ' (sin escritura)'}.`,
      'Implementar cambios en un Codespace con el modelo configurado.',
      isWriteEnabled()
        ? 'Hacer add, commit y push a GitHub con aprobación explícita.'
        : 'Escritura desactivada: define ALLOW_WRITE_OPERATIONS=true para habilitar add, commit y push.',
      '',
      'En preparación:',
      'Enviar capturas de pantalla y audios de cada cambio.',
      'Crear Codespaces nuevos de forma automática.',
    ].join('\n');
  }

  private pendingPlan(context: AgentContext): string {
    const pending = context.pendingChange;
    if (!pending) return 'No hay ningún plan de cambio pendiente.';
    const details = [
      `Plan pendiente (${pending.status}):`,
      '',
      pending.plan,
    ];
    if (pending.branch) details.push('', `Rama de trabajo: ${pending.branch}`);
    if (pending.commitSha) details.push(`Commit: ${pending.commitSha.slice(0, 7)}`);
    if (pending.failure) details.push('', `Último fallo: ${pending.failure}`);
    details.push('', 'Usa /aceptar para implementarlo o /cancelar para descartarlo. Cuando quieras subirlo, escribe aceptarcambiosysubiragthub.');
    return details.join('\n');
  }

  private async approvePlan(message: IncomingMessage, context: AgentContext): Promise<string> {
    const pending = context.pendingChange;
    if (!pending) return 'No hay ningún plan pendiente para aprobar.';
    if (pending.status !== 'awaiting_approval' && pending.status !== 'failed') {
      return `El plan ya está en estado ${pending.status}. Usa /plan para ver los detalles.`;
    }
    if (!this.workspaceRunner) {
      return 'No puedo implementar todavía: falta configurar GITHUB_CODESPACES_NAME y el runner del Codespace.';
    }
    if (!context.currentRepository) {
      return 'Primero selecciona un repositorio con /repos y /repo <nombre>.';
    }

    const chatId = message.chatId ?? message.userId;
    const job = this.jobs.begin(chatId, `implementar cambios en ${context.currentRepository}`);
    if (!job) {
      return `Ya hay una tarea en curso (${this.jobs.current(chatId)?.description ?? 'sin detalle'}). Espera a que termine.`;
    }

    pending.status = 'implementing';
    pending.failure = undefined;
    this.persistContext(context);

    void this.runImplementJob(job, context)
      .catch(async (error) => {
        pending.status = 'failed';
        pending.failure = describeError(error);
        this.persistContext(context);
        await job.notify(`No pude implementar los cambios: ${describeError(error)}`);
      })
      .finally(() => this.jobs.finish(chatId));

    return `⏳ Plan aprobado. Estoy implementando los cambios en el Codespace de ${context.currentRepository}. Te aviso en cuanto termine.`;
  }

  private async runImplementJob(job: JobContext, context: AgentContext): Promise<void> {
    const repository = context.currentRepository!;
    const codespaceName = await this.resolveCodespace(repository);
    if (!codespaceName) {
      throw new Error('No encontré el Codespace de trabajo. Definí GITHUB_CODESPACES_NAME con el nombre del Codespace.');
    }
    const pending = context.pendingChange!;
    const root = codespaceWorkdirFor();

    await job.notify(
      `🧹 Preparando ${codespaceName}: subo la implementación anterior si quedaba algo pendiente, limpio la carpeta de trabajo y clono ${repository}…`,
    );
    const preparation = await prepareWorkspace(this.workspaceRunner!, codespaceName, root, {
      repositoryFullName: repository,
      defaultBranch: context.selectedBranch ?? await this.repositoryManager!.getDefaultBranch(context),
    });
    const workdir = preparation.repoDir;

    if (preparation.previousBranches.length > 0) {
      await job.notify(
        `📤 Subí los cambios pendientes de la implementación anterior en: ${preparation.previousBranches.join(', ')}.`,
      );
    }
    await job.notify(`🧼 Lugar de trabajo limpio. Trabajando en ${workdir}.`);

    await job.notify(`🔧 Implementando en el Codespace ${codespaceName}…`);
    const result = await this.implementChanges(codespaceName, workdir, context, (text) => job.notify(text));

    if (result.timedOut || result.exitCode !== 0) {
      pending.status = 'failed';
      pending.failure = result.timedOut
        ? 'El agente del Codespace agotó el tiempo de implementación.'
        : `El agente devolvió el código de salida ${result.exitCode}.`;
      this.persistContext(context);
      await job.notify(`No pude completar la implementación.\n\n${pending.failure}\n\n${tail(result.output)}`);
      return;
    }

    pending.implementation = tail(result.output, 2000);
    pending.status = 'implemented';
    pending.updatedAt = new Date().toISOString();
    this.persistContext(context);

    await job.notify([
      '✅ Cambios implementados en el Codespace.',
      '',
      tail(result.output, 1500),
      '',
      'Cuando quieras, escribe aceptarcambiosysubiragthub y hago add, commit y push.',
    ].join('\n'));
  }

  private async publishChanges(message: IncomingMessage, context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    if (!context.currentRepository) {
      return 'Primero selecciona un repositorio con /repos y /repo <nombre>.';
    }
    if (!this.workspaceRunner) {
      return 'No puedo subir cambios: falta configurar el Codespace (GITHUB_CODESPACES_NAME) y el runner.';
    }
    if (!isWriteEnabled()) {
      return 'Las operaciones de escritura están desactivadas. Define ALLOW_WRITE_OPERATIONS=true en el entorno para habilitar add, commit y push.';
    }
    const pending = context.pendingChange;
    if (!pending) {
      return 'No hay cambios pendientes. Descríbeme antes qué quieres modificar y te prepararé un plan.';
    }
    if (pending.status === 'cancelled') {
      return 'El último plan fue cancelado. Pídeme un cambio nuevo y te prepararé otro plan.';
    }
    if (pending.status === 'publishing') {
      return 'Ya estoy subiendo esos cambios. Espera a que termine.';
    }

    const chatId = message.chatId ?? message.userId;
    const job = this.jobs.begin(chatId, `subir cambios de ${context.currentRepository}`);
    if (!job) {
      return `Ya hay una tarea en curso (${this.jobs.current(chatId)?.description ?? 'sin detalle'}). Espera a que termine.`;
    }

    void this.runPublishJob(job, context)
      .catch(async (error) => {
        const current = context.pendingChange;
        if (current) {
          current.status = 'failed';
          current.failure = describeError(error);
          this.persistContext(context);
        }
        await job.notify(`No pude subir los cambios: ${describeError(error)}`);
      })
      .finally(() => this.jobs.finish(chatId));

    return `⏳ En marcha sobre ${context.currentRepository}. Hago add, commit y push. Te voy contando el progreso.`;
  }

  private async runPublishJob(job: JobContext, context: AgentContext): Promise<void> {
    const repository = context.currentRepository!;
    const codespaceName = await this.resolveCodespace(repository);
    if (!codespaceName) {
      throw new Error('No encontré el Codespace de trabajo. Definí GITHUB_CODESPACES_NAME con el nombre del Codespace.');
    }
    const workdir = codespaceWorkdirFor(repository);
    const pending = context.pendingChange!;

    if (pending.status === 'awaiting_approval' || pending.status === 'failed') {
      await this.runImplementJob(job, context);
      if (context.pendingChange?.status !== 'implemented') return;
    }

    const branch = pending.branch ?? buildAgentBranch();
    pending.branch = branch;
    pending.status = 'publishing';
    this.persistContext(context);

    const isUpdate = Boolean(pending.commitSha);
    await job.notify(`📤 Haciendo add, commit y push a la rama ${branch}…`);

    grantWriteCapabilities();
    try {
      const commitMessage = this.buildCommitMessage(pending.request, pending.plan, isUpdate);
      const pushed = await commitAndPush(this.workspaceRunner!, codespaceName, workdir, {
        branch,
        message: commitMessage,
      });
      pending.changedFiles = pushed.changedFiles;
      pending.commitSha = pushed.commitSha;
      pending.updatedAt = new Date().toISOString();
      this.persistContext(context);

      await job.notify([
        `💾 Commit ${pushed.commitSha.slice(0, 7)} creado en ${branch}.`,
        pushed.changedFiles.length > 0
          ? `Archivos: ${pushed.changedFiles.slice(0, 20).join(', ')}`
          : 'Sin archivos listados.',
      ].join('\n'));

      pending.status = 'published';
      pending.failure = undefined;
      pending.updatedAt = new Date().toISOString();
      this.persistContext(context);

      await job.notify([
        `✅ Listo. Cambios subidos a ${repository}.`,
        '',
        `Rama: ${branch}`,
        `Commit: ${pushed.commitSha.slice(0, 7)}`,
        '',
        pushed.changedFiles.length > 0
          ? `Archivos modificados:\n${pushed.changedFiles.map((file) => `- ${file}`).join('\n')}`
          : 'No se listaron archivos modificados.',
        '',
        `La rama ${branch} ya está en GitHub con los cambios.`,
      ].join('\n'));

      await this.attachDiff(job, codespaceName, workdir, branch);
    } finally {
      revokeWriteCapabilities();
    }
  }

  private async implementChanges(
    codespaceName: string,
    workdir: string,
    context: AgentContext,
    notify?: (text: string) => Promise<void>,
  ): Promise<WorkspaceExecutionResult> {
    const task = this.buildImplementationTask(context);

    if (isDeepSeekConfigured()) {
      try {
        const result = await runDeepSeekCodingTask({
          runner: this.workspaceRunner!,
          codespaceName,
          workdir,
          task,
          ...(notify ? { notify } : {}),
        });
        return {
          output: [
            result.summary,
            '',
            `Pasos del agente: ${result.steps}`,
            result.filesTouched.length > 0
              ? `Archivos modificados: ${result.filesTouched.join(', ')}`
              : 'No se registraron escrituras de archivos.',
          ].join('\n'),
          exitCode: 0,
          timedOut: false,
        };
      } catch (error) {
        return { output: describeError(error), exitCode: 1, timedOut: false };
      }
    }

    return this.workspaceRunner!.delegate(codespaceName, task, 'implement', { workdir });
  }

  private buildImplementationTask(context: AgentContext): string {
    const pending = context.pendingChange!;
    return [
      `Trabaja en el repositorio ${context.currentRepository} dentro del directorio actual del Codespace.`,
      '',
      `Solicitud original del usuario: ${pending.request}`,
      '',
      'Plan aprobado:',
      pending.plan,
      '',
      'Instrucciones:',
      '- Trabaja sobre la rama actual del workspace; no crees ramas nuevas.',
      '- Modifica únicamente los archivos necesarios para cumplir la solicitud.',
      '- Ejecuta las pruebas o comprobaciones disponibles y arregla lo que rompas.',
      '- No hagas commit ni push: de eso me encargo yo.',
      '- Termina con un resumen en texto plano: archivos modificados, comandos ejecutados, resultado de pruebas y riesgos.',
    ].join('\n');
  }

  private async attachDiff(
    job: JobContext,
    codespaceName: string,
    workdir: string,
    branch: string,
  ): Promise<void> {
    if (!job.attachFile) return;
    const remotePath = `/tmp/agent-${job.id}.diff`;
    const localPath = join(tmpdir(), `agent-${job.id}.diff`);
    try {
      await this.workspaceRunner!.execute(
        codespaceName,
        `git diff "HEAD~1" "HEAD" > ${shellQuote(remotePath)} 2>/dev/null || true`,
        { workdir, timeoutMs: env.codespaceGitTimeoutMs },
      );
      await this.workspaceRunner!.collectFile(codespaceName, remotePath, localPath);
      await job.attachFile(localPath, `Diff del commit en ${branch}`);
    } catch (error) {
      console.error('No pude adjuntar el diff:', describeError(error));
    }
  }

  private buildCommitMessage(request: string, plan: string, isUpdate: boolean): string {
    const summary = (request.split('\n')[0] ?? '').trim().slice(0, 68) || 'cambios del agente';
    const body = plan.trim().split('\n').slice(0, 6).join('\n').slice(0, 400);
    return [
      `${isUpdate ? 'Actualiza' : 'Añade'}: ${summary}`,
      '',
      body,
      '',
      'Generado por el agente de Telegram para desarrollo.',
    ].join('\n');
  }

  private async resolveCodespace(repositoryFullName: string): Promise<string | undefined> {
    if (this.workspaceRunner?.resolveCodespace) {
      return this.workspaceRunner.resolveCodespace(repositoryFullName);
    }
    return env.githubCodespacesName || undefined;
  }

  private cancelPlan(context: AgentContext): string {
    if (!context.pendingChange || context.pendingChange.status !== 'awaiting_approval') {
      return 'No hay ningún plan pendiente para cancelar.';
    }
    context.pendingChange.status = 'cancelled';
    context.pendingChange.updatedAt = new Date().toISOString();
    return 'Plan cancelado. No se han modificado archivos ni repositorios.';
  }

  private async reviewChanges(context: AgentContext): Promise<string> {
    if (!this.workspaceRunner || !env.codespaceAgentCommand) {
      return 'El agente del Codespace no está configurado. Define CODESPACE_AGENT_COMMAND para revisar los cambios.';
    }
    if (!context.currentRepository) return 'Primero selecciona un repositorio con /repo <nombre>.';
    const codespaceName = await this.resolveCodespace(context.currentRepository);
    if (!codespaceName) return 'No encontré el Codespace de trabajo. Definí GITHUB_CODESPACES_NAME.';
    try {
      const result = await this.workspaceRunner.delegate(
        codespaceName,
        'Revisa los cambios actuales del workspace. Ejecuta git diff, las pruebas apropiadas y devuelve un informe de revisión en texto plano con archivos modificados, problemas encontrados, tests y recomendación final. No hagas push ni abras PR.',
        'review',
        { workdir: codespaceWorkdirFor(context.currentRepository) },
      );
      if (result.exitCode !== 0) {
        return `La revisión falló con el código ${result.exitCode}.\n\n${tail(result.output)}`;
      }
      return `Revisión del agente del Codespace:\n\n${result.output || 'El agente no devolvió un informe.'}`;
    } catch (error) {
      return `No pude solicitar la revisión: ${describeError(error)}`;
    }
  }

  private async createChangePlan(request: string, context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    if (!context.currentRepository) {
      return 'Primero selecciona un repositorio con /repos y /repo <nombre>. Después describe el cambio que quieres realizar.';
    }
    try {
      const repositoryContext = context.repositoryContext ?? await this.repositoryManager.buildContext(context);
      const planningTask = `Planifica esta solicitud para el repositorio ${context.currentRepository}.\nSolicitud del usuario: ${request}\nContexto del repositorio:\n${repositoryContextFacts(repositoryContext)}\nDevuelve texto plano con objetivo, archivos, cambios, validaciones, riesgos y preguntas bloqueantes. No modifiques archivos.`;
      const plan = !isDeepSeekConfigured() && this.workspaceRunner && env.githubCodespacesName && env.codespacePlannerCommand
        ? (await this.workspaceRunner.delegate(env.githubCodespacesName, planningTask, 'plan')).output
        : await this.modelRouter.generate({
          taskType: 'PLANNING',
          systemPrompt: 'Genera un plan de cambio para el repositorio usando únicamente el contexto proporcionado. Devuelve texto plano, sin Markdown decorativo. Incluye: objetivo, archivos probables, cambios propuestos, validaciones, riesgos y preguntas bloqueantes. No ejecutes cambios ni inventes archivos.',
          userPrompt: planningTask,
        });
      context.pendingChange = {
        request,
        plan,
        status: 'awaiting_approval',
        branch: buildAgentBranch(),
        baseBranch: context.selectedBranch,
        updatedAt: new Date().toISOString(),
      };
      return [
        `He preparado este plan para ${context.currentRepository}:`,
        '',
        plan,
        '',
        'Usa /aceptar para implementarlo, /cancelar para descartarlo o aceptarcambiosysubiragthub para implementarlo y subirlo a GitHub.',
      ].join('\n');
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private async createCodespace(context: AgentContext): Promise<string> {
    if (!context.currentRepository) return 'Primero selecciona un repositorio con /repo <nombre>.';
    if (!this.workspaceProvider) return 'Codespaces no está configurado. Añade GITHUB_CODESPACES_TOKEN con permisos de Codespaces.';
    try {
      const workspace = await this.workspaceProvider.prepare({
        repository: context.currentRepository,
        branch: context.selectedBranch ?? 'main',
        task: 'workspace interactivo del agente',
      });
      return `Codespace creado para ${context.currentRepository}:\n${workspace}\n\nLa API ha creado el entorno. Para ejecutar cambios automáticamente falta conectar un runner de terminal autenticado.`;
    } catch (error) {
      return `No pude crear el Codespace: ${error instanceof Error ? error.message : 'error desconocido'}`;
    }
  }

  private async readFile(context: AgentContext, path: string): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const content = await this.repositoryManager.getFile(context, path);
      const limit = 3500;
      const suffix = content.length > limit ? '\n\n[contenido truncado]' : '';
      return `Archivo ${path}:\n\n${content.slice(0, limit)}${suffix}`;
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private async listIssues(context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const issues = await this.repositoryManager.getIssues(context);
      return `Issues abiertos:\n\n${issues.length ? issues.map((issue) => `#${issue.number} ${issue.title}\n${issue.url}`).join('\n\n') : 'No hay issues abiertos.'}`;
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private async listPullRequests(context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    try {
      const pullRequests = await this.repositoryManager.getPullRequests(context);
      return `Pull requests abiertos:\n\n${pullRequests.length ? pullRequests.map((pullRequest) => `#${pullRequest.number} ${pullRequest.title}\n${pullRequest.url}`).join('\n\n') : 'No hay pull requests abiertos.'}`;
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private describeContext(context: AgentContext): string {
    if (!context.repositoryContext) return 'Todavía no hay un contexto de repositorio. Selecciona y analiza un repositorio primero.';
    const repository = context.repositoryContext.repository;
    return [
      'Contexto actual:',
      `Repositorio: ${repository.owner}/${repository.name}`,
      `Branch: ${repository.defaultBranch}`,
      `Archivos detectados: ${context.repositoryContext.directoryTree.length}`,
      `Tests detectados: ${context.repositoryContext.detected.tests.length}`,
      `Documentación detectada: ${context.repositoryContext.documentation.length}`,
    ].join('\n');
  }

  private status(context: AgentContext): string {
    const job = context.user?.id ? this.jobs.current(context.user.id) : undefined;
    return [
      'Estado del agente:',
      'Modo: análisis, implementación y publicación',
      `Repositorio: ${context.currentRepository ?? 'ninguno'}`,
      `Branch: ${context.selectedBranch ?? 'ninguna'}`,
      `Permisos de escritura: ${isWriteEnabled() ? 'habilitados' : 'deshabilitados'}`,
      `Codespace de trabajo: ${env.githubCodespacesName || 'no configurado'}`,
      `Carpeta de trabajo: ${codespaceWorkdirFor(context.currentRepository)}`,
      `Cambio pendiente: ${context.pendingChange?.status ?? 'ninguno'}`,
      `Tarea en curso: ${job ? job.description : 'ninguna'}`,
    ].join('\n');
  }

  private async analyzeRepository(name: string | undefined, context: AgentContext): Promise<string> {
    if (!this.repositoryManager) return this.githubNotConfigured();
    if (name && (!context.currentRepository || !context.currentRepository.toLowerCase().endsWith(`/${name.toLowerCase()}`))) {
      const selection = await this.repositoryManager.selectRepository(name, context);
      if (!selection) return 'No se pudo seleccionar el repositorio.';
    }
    if (!context.currentRepository) {
      return 'Primero usa /repos y después /repo <nombre>. Luego puedes pedirme: analiza el proyecto, dime de qué trata, qué lenguaje usa y cómo está estructurado.';
    }
    try {
      const repositoryContext = await this.repositoryManager.buildContext(context);
      context.repositoryContext = repositoryContext;
      const report = buildProjectReport(repositoryContext);
      const narrative = await this.tryNarrativeAnalysis(context, repositoryContext);
      if (!narrative) {
        return `${report}\n\n---\nNo pude generar la narrativa del modelo ahora mismo, pero el informe de arriba usa datos reales de GitHub.`;
      }
      return `${report}\n\n---\nAnálisis del modelo:\n\n${narrative}`;
    } catch (error) {
      return this.errorMessage(error);
    }
  }

  private async tryNarrativeAnalysis(
    context: AgentContext,
    repositoryContext: NonNullable<AgentContext['repositoryContext']>,
  ): Promise<string | undefined> {
    try {
      return await this.modelRouter.generate({
        taskType: 'ARCHITECTURE',
        systemPrompt: 'Analiza el repositorio basándote únicamente en los datos reales de GitHub proporcionados. Explica el propósito, los patrones de arquitectura que ves, los flujos principales, los riesgos y las mejoras recomendadas. Distingue DATOS OBTENIDOS DE GITHUB e INFERENCIAS. No repitas la ficha técnica y aclara que no se han realizado cambios.',
        userPrompt: `Analiza este RepositoryContext del repositorio ${context.currentRepository}:\n${repositoryContextFacts(repositoryContext)}`,
      });
    } catch (error) {
      console.error('El análisis narrativo falló:', describeError(error));
      return undefined;
    }
  }

  private githubNotConfigured(): string {
    return 'GitHub no está configurado. Define GITHUB_TOKEN o GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY y GITHUB_INSTALLATION_ID.';
  }

  private errorMessage(error: unknown): string {
    if (error instanceof GitHubClientError) return error.message;
    if (error instanceof PermissionError) {
      return `${error.message} Habilita ALLOW_WRITE_OPERATIONS=true y aprueba el plan antes de reintentar.`;
    }
    if (error instanceof GitOperationError) return error.message;
    return `No pude completar la operación: ${describeError(error)}`;
  }
}