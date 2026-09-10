import { Octokit } from '@octokit/rest';
import { env } from '../config/env';
import type { WorkspacePlan, WorkspaceProvider, WorkspaceRequest } from './types';

export class GitHubCodespacesProvider implements WorkspaceProvider {
  private readonly client: Octokit;

  constructor(token = env.githubCodespacesToken) {
    if (!token) throw new Error('GITHUB_CODESPACES_TOKEN no está configurado.');
    this.client = new Octokit({ auth: token, request: { timeout: 30_000 } });
  }

  async prepare(request: WorkspaceRequest): Promise<string> {
    const [owner, repository] = request.repository.split('/', 2);
    const repositoryResponse = await this.client.rest.repos.get({ owner, repo: repository });
    const response = await this.client.rest.codespaces.createForAuthenticatedUser({
      repository_id: repositoryResponse.data.id,
      ref: request.branch,
      machine: env.githubCodespacesMachine,
      idle_timeout_minutes: 30,
    } as never);
    const data = response.data as { name?: string; web_url?: string; url?: string };
    return data.web_url ?? data.url ?? data.name ?? 'Codespace creado sin URL disponible.';
  }

  async apply(): Promise<void> {
    throw new Error('Usa WorkspaceRunner.delegate para hablar con el agente instalado en el Codespace.');
  }

  async runValidation(): Promise<string> {
    throw new Error('La validación requiere un runner conectado al Codespace.');
  }

  async destroy(workspaceId: string): Promise<void> {
    await this.client.rest.codespaces.deleteForAuthenticatedUser({ codespace_name: workspaceId });
  }
}