export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  description?: string;
  language?: string;
  visibility?: string;
  private: boolean;
  htmlUrl?: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

export interface GitHubFile {
  path: string;
  content: string;
  encoding: string;
  size?: number;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

export interface GitHubRepositoryStatus {
  repository: GitHubRepository;
  branch: GitHubBranch;
  openIssues: number;
  openPullRequests: number;
  recentBranches: GitHubBranch[];
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
}

export interface GitHubSearchResult {
  repository: GitHubRepository;
  score: number;
}

export interface GitHubPullRequestResult {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
}

export interface GitHubClient {
  listRepositories(): Promise<GitHubRepository[]>;
  getRepository(owner: string, repository: string): Promise<GitHubRepository>;
  getRepositoryTree(owner: string, repository: string, branch: string): Promise<GitHubTreeEntry[]>;
  getFile(owner: string, repository: string, path: string, branch?: string): Promise<GitHubFile>;
  searchCode(owner: string, repository: string, query: string): Promise<GitHubSearchResult[]>;
  getReadme(owner: string, repository: string, branch?: string): Promise<GitHubFile>;
  getBranch(owner: string, repository: string, branch: string): Promise<GitHubBranch>;
  listBranches(owner: string, repository: string): Promise<GitHubBranch[]>;
  getPullRequests(owner: string, repository: string): Promise<GitHubPullRequest[]>;
  getIssues(owner: string, repository: string): Promise<GitHubIssue[]>;
  createPullRequest(
    owner: string,
    repository: string,
    title: string,
    head: string,
    base: string,
    body?: string,
  ): Promise<GitHubPullRequestResult>;
}

export type GitHubErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMIT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR';

export class GitHubClientError extends Error {
  constructor(
    public readonly code: GitHubErrorCode,
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GitHubClientError';
  }
}