import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { env } from '../config/env';
import { Capability, assertCapability } from './permissions';
import {
  GitHubClientError,
  type GitHubBranch,
  type GitHubClient,
  type GitHubFile,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubPullRequestResult,
  type GitHubRepository,
  type GitHubSearchResult,
  type GitHubTreeEntry,
} from './types';

interface OctokitLike {
  rest: Octokit['rest'];
}

function toRepository(repository: any): GitHubRepository {
  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.full_name,
    owner: repository.owner.login,
    defaultBranch: repository.default_branch,
    description: repository.description ?? undefined,
    language: repository.language ?? undefined,
    visibility: repository.visibility ?? undefined,
    private: repository.private,
    htmlUrl: repository.html_url,
  };
}

function mapError(error: unknown): GitHubClientError {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: number }).status)
    : undefined;
  const causeMessage = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 180) : '';
  const message = status === 401
    ? 'GitHub rechazó la autenticación de la GitHub App.'
    : status === 403 || status === 429
      ? 'GitHub rechazó la solicitud o se alcanzó el rate limit.'
      : status === 404
        ? 'El recurso de GitHub no existe o no está autorizado.'
        : causeMessage
          ? `GitHub no pudo completar la solicitud: ${causeMessage}`
          : 'GitHub no pudo completar la solicitud.';
  const code = status === 401
    ? 'AUTHENTICATION_ERROR'
    : status === 403 || status === 429
      ? (status === 429 ? 'RATE_LIMIT' : 'FORBIDDEN')
      : status === 404
        ? 'NOT_FOUND'
        : error instanceof Error && error.name === 'AbortError'
          ? 'TIMEOUT'
          : 'UPSTREAM_ERROR';
  return new GitHubClientError(code, message, status, { cause: error });
}

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: OctokitLike;
  private readonly usesPersonalToken: boolean;

  constructor(octokit?: OctokitLike) {
    if (octokit) {
      this.octokit = octokit;
      this.usesPersonalToken = false;
      return;
    }
    if (env.githubToken) {
      this.octokit = new Octokit({
        auth: env.githubToken,
        request: { timeout: 15_000 },
      });
      this.usesPersonalToken = true;
      return;
    }
    if (!env.githubAppId || !env.githubAppPrivateKey || !env.githubInstallationId) {
      throw new GitHubClientError(
        'AUTHENTICATION_ERROR',
        'Configura GITHUB_TOKEN o GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY y GITHUB_INSTALLATION_ID.',
      );
    }
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: env.githubAppId,
        privateKey: env.githubAppPrivateKey,
        installationId: env.githubInstallationId,
      },
      request: { timeout: 15_000 },
    });
    this.usesPersonalToken = false;
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    assertCapability(Capability.READ_REPOSITORY);
    try {
      if (this.usesPersonalToken) {
        const response = await this.octokit.rest.repos.listForAuthenticatedUser({
          per_page: 100,
          affiliation: 'owner,collaborator,organization_member',
          sort: 'full_name',
        });
        return response.data.map(toRepository);
      }
      const response = await this.octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
      return response.data.repositories.map(toRepository);
    } catch (error) {
      throw mapError(error);
    }
  }

  async getRepository(owner: string, repository: string): Promise<GitHubRepository> {
    assertCapability(Capability.READ_REPOSITORY);
    try {
      const response = await this.octokit.rest.repos.get({ owner, repo: repository });
      return toRepository(response.data);
    } catch (error) {
      throw mapError(error);
    }
  }

  async getRepositoryTree(owner: string, repository: string, branch: string): Promise<GitHubTreeEntry[]> {
    assertCapability(Capability.READ_FILES);
    try {
      const response = await this.octokit.rest.git.getTree({ owner, repo: repository, tree_sha: branch, recursive: 'true' });
      return response.data.tree
        .filter((entry) => entry.path && (entry.type === 'blob' || entry.type === 'tree'))
        .map((entry) => ({ path: entry.path as string, type: entry.type as 'blob' | 'tree', size: entry.size }));
    } catch (error) {
      throw mapError(error);
    }
  }

  async getFile(owner: string, repository: string, path: string, branch?: string): Promise<GitHubFile> {
    assertCapability(Capability.READ_FILES);
    try {
      const response = await this.octokit.rest.repos.getContent({ owner, repo: repository, path, ref: branch });
      const data = response.data as { type: string; path: string; content?: string; encoding?: string; size?: number };
      if (data.type !== 'file' || !data.content) throw new GitHubClientError('NOT_FOUND', 'El archivo solicitado no está disponible.');
      return {
        path: data.path,
        content: Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'),
        encoding: data.encoding ?? 'utf-8',
        size: data.size,
      };
    } catch (error) {
      if (error instanceof GitHubClientError) throw error;
      throw mapError(error);
    }
  }

  async searchCode(owner: string, repository: string, query: string): Promise<GitHubSearchResult[]> {
    assertCapability(Capability.READ_FILES);
    try {
      const response = await this.octokit.rest.search.code({ q: `${query} repo:${owner}/${repository}` });
      return response.data.items.map((item) => ({ repository: toRepository(item.repository), score: item.score ?? 0 }));
    } catch (error) {
      throw mapError(error);
    }
  }

  async getReadme(owner: string, repository: string, branch?: string): Promise<GitHubFile> {
    assertCapability(Capability.READ_FILES);
    return this.getFile(owner, repository, 'README.md', branch);
  }

  async getBranch(owner: string, repository: string, branch: string): Promise<GitHubBranch> {
    assertCapability(Capability.READ_REPOSITORY);
    try {
      const response = await this.octokit.rest.repos.getBranch({ owner, repo: repository, branch });
      return { name: response.data.name, protected: response.data.protected };
    } catch (error) {
      throw mapError(error);
    }
  }

  async listBranches(owner: string, repository: string): Promise<GitHubBranch[]> {
    assertCapability(Capability.READ_REPOSITORY);
    try {
      const response = await this.octokit.rest.repos.listBranches({
        owner,
        repo: repository,
        per_page: 100,
      });
      return response.data.map((branch) => ({ name: branch.name, protected: branch.protected }));
    } catch (error) {
      throw mapError(error);
    }
  }

  async getPullRequests(owner: string, repository: string): Promise<GitHubPullRequest[]> {
    assertCapability(Capability.READ_PULL_REQUESTS);
    try {
      const response = await this.octokit.rest.pulls.list({ owner, repo: repository, state: 'open', per_page: 10 });
      return response.data.map((pull) => ({ number: pull.number, title: pull.title, state: pull.state, url: pull.html_url }));
    } catch (error) {
      throw mapError(error);
    }
  }

  async getIssues(owner: string, repository: string): Promise<GitHubIssue[]> {
    assertCapability(Capability.READ_ISSUES);
    try {
      const response = await this.octokit.rest.issues.listForRepo({ owner, repo: repository, state: 'open', per_page: 10 });
      return response.data
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, url: issue.html_url }));
    } catch (error) {
      throw mapError(error);
    }
  }

  async createPullRequest(
    owner: string,
    repository: string,
    title: string,
    head: string,
    base: string,
    body?: string,
  ): Promise<GitHubPullRequestResult> {
    assertCapability(Capability.CREATE_PR);
    try {
      const response = await this.octokit.rest.pulls.create({
        owner,
        repo: repository,
        title,
        head,
        base,
        body: body ?? '',
      });
      return {
        number: response.data.number,
        title: response.data.title,
        url: response.data.html_url,
        head,
        base,
      };
    } catch (error) {
      throw mapError(error);
    }
  }
}