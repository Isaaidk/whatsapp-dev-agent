import type { AgentContext } from '../agent/context';
import { Capability, assertCapability } from './permissions';
import type { RepositoryContext } from './repository-context';
import type { GitHubClient, GitHubPullRequestResult, GitHubRepository, GitHubRepositoryStatus } from './types';
import { GitHubClientError } from './types';

const CONFIGURATION_PATHS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
];

function friendlyRepositoryError(error: unknown): Error {
  if (error instanceof GitHubClientError) return error;
  return new GitHubClientError('UPSTREAM_ERROR', 'No se pudo consultar el repositorio en GitHub.', undefined, { cause: error });
}

export class RepositoryManager {
  constructor(private readonly client?: GitHubClient) {}

  private getClient(): GitHubClient {
    if (!this.client) {
      throw new GitHubClientError(
        'AUTHENTICATION_ERROR',
        'GitHub no está configurado. Define GITHUB_TOKEN o las credenciales de la GitHub App.',
      );
    }
    return this.client;
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    assertCapability(Capability.READ_REPOSITORY);
    try {
      return await this.getClient().listRepositories();
    } catch (error) {
      throw friendlyRepositoryError(error);
    }
  }

  async findRepositories(name: string): Promise<GitHubRepository[]> {
    const repositories = await this.listRepositories();
    const normalized = name.trim().toLowerCase();
    return repositories.filter((repository) =>
      repository.name.toLowerCase() === normalized || repository.fullName.toLowerCase() === normalized,
    );
  }

  async selectRepository(name: string, context: AgentContext): Promise<GitHubRepository> {
    const matches = await this.findRepositories(name);
    if (matches.length === 0) {
      throw new GitHubClientError('NOT_FOUND', `No encontré un repositorio autorizado llamado ${name}.`);
    }
    if (matches.length > 1) {
      throw new GitHubClientError('UPSTREAM_ERROR', `Hay varios repositorios que coinciden con ${name}.`);
    }
    const repository = matches[0];
    context.currentRepository = repository.fullName;
    context.selectedBranch = repository.defaultBranch;
    context.repositoryContext = undefined;
    return repository;
  }

  getCurrentRepository(context: AgentContext): string | undefined {
    return context.currentRepository;
  }

  async getStatus(context: AgentContext): Promise<GitHubRepositoryStatus> {
    assertCapability(Capability.READ_REPOSITORY);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    const repository = await this.getClient().getRepository(owner, name);
    const branch = await this.getClient().getBranch(owner, name, repository.defaultBranch);
    const [issues, pullRequests, branches] = await Promise.all([
      this.getClient().getIssues(owner, name),
      this.getClient().getPullRequests(owner, name),
      this.getClient().listBranches(owner, name),
    ]);
    return {
      repository,
      branch,
      openIssues: issues.length,
      openPullRequests: pullRequests.length,
      recentBranches: branches.slice(0, 20),
    };
  }

  async getFile(context: AgentContext, path: string): Promise<string> {
    assertCapability(Capability.READ_FILES);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    const file = await this.getClient().getFile(owner, name, path, context.selectedBranch);
    return file.content;
  }

  async getIssues(context: AgentContext): Promise<ReadonlyArray<{ number: number; title: string; url: string }>> {
    assertCapability(Capability.READ_ISSUES);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    return this.getClient().getIssues(owner, name);
  }

  async getPullRequests(context: AgentContext): Promise<ReadonlyArray<{ number: number; title: string; url: string }>> {
    assertCapability(Capability.READ_PULL_REQUESTS);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    return this.getClient().getPullRequests(owner, name);
  }

  async getDefaultBranch(context: AgentContext): Promise<string> {
    assertCapability(Capability.READ_REPOSITORY);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    const repository = await this.getClient().getRepository(owner, name);
    return repository.defaultBranch;
  }

  async createPullRequest(
    context: AgentContext,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitHubPullRequestResult> {
    assertCapability(Capability.CREATE_PR);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    try {
      return await this.getClient().createPullRequest(
        owner,
        name,
        input.title,
        input.head,
        input.base,
        input.body,
      );
    } catch (error) {
      throw friendlyRepositoryError(error);
    }
  }

  async buildContext(context: AgentContext): Promise<RepositoryContext> {
    assertCapability(Capability.ANALYZE_REPOSITORY);
    if (!context.currentRepository) {
      throw new GitHubClientError('NOT_FOUND', 'Primero selecciona un repositorio con /repo <nombre>.');
    }
    const [owner, name] = context.currentRepository.split('/', 2);
    const repository = await this.getClient().getRepository(owner, name);
    const branch = repository.defaultBranch;
    context.selectedBranch = branch;
    const [tree, readme, issues, pullRequests] = await Promise.all([
      this.getClient().getRepositoryTree(owner, name, branch),
      this.getOptionalFile(() => this.getClient().getReadme(owner, name, branch)),
      this.getClient().getIssues(owner, name),
      this.getClient().getPullRequests(owner, name),
    ]);
    const paths = tree.map((entry) => entry.path);
    const existingPaths = new Set(paths);
    const configurationFiles = (await Promise.all(
      CONFIGURATION_PATHS
        .filter((path) => existingPaths.has(path))
        .map(async (path) => {
        const file = await this.getOptionalFile(() => this.getClient().getFile(owner, name, path, branch));
        return file ? { path, content: file.content.slice(0, 12000) } : undefined;
        }),
    )).filter((file): file is { path: string; content: string } => Boolean(file));

    const documentation = paths.filter((path) => /(^|\/)(docs?|documentation)(\/|$)|\.md$/i.test(path)).slice(0, 50);
    const tests = paths.filter((path) => /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\./i.test(path)).slice(0, 50);
    const stack = this.detectStack(repository, configurationFiles, paths);
    const repositoryContext: RepositoryContext = {
      repository: {
        name: repository.name,
        owner: repository.owner,
        defaultBranch: repository.defaultBranch,
        description: repository.description,
        language: repository.language,
        visibility: repository.visibility,
      },
      readme: readme?.content.slice(0, 12000),
      directoryTree: tree.slice(0, 500),
      configurationFiles,
      documentation,
      recentActivity: { issues, pullRequests },
      detected: { stack, tests },
      source: 'github',
    };
    context.repositoryContext = repositoryContext;
    context.state = 'analysis';
    return repositoryContext;
  }

  private async getOptionalFile<T>(loader: () => Promise<T>): Promise<T | undefined> {
    try {
      return await loader();
    } catch (error) {
      if (error instanceof GitHubClientError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  private detectStack(repository: GitHubRepository, files: Array<{ path: string }>, paths: string[]): string[] {
    const stack = repository.language ? [repository.language] : [];
    const filePaths = new Set(files.map((file) => file.path));
    if (filePaths.has('package.json') || paths.some((path) => path.endsWith('.ts') || path.endsWith('.js'))) stack.push('Node.js');
    if (filePaths.has('package.json')) stack.push('JavaScript/TypeScript');
    if (filePaths.has('pyproject.toml') || filePaths.has('requirements.txt')) stack.push('Python');
    if (filePaths.has('go.mod')) stack.push('Go');
    return [...new Set(stack)];
  }
}