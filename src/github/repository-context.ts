import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  GitHubTreeEntry,
} from './types';

export interface RepositoryContext {
  repository: {
    name: string;
    owner: string;
    defaultBranch: string;
    description?: string;
    language?: string;
    visibility?: string;
  };
  readme?: string;
  directoryTree: GitHubTreeEntry[];
  configurationFiles: Array<{ path: string; content: string }>;
  documentation: string[];
  recentActivity: {
    issues: GitHubIssue[];
    pullRequests: GitHubPullRequest[];
  };
  detected: {
    stack: string[];
    tests: string[];
  };
  source: 'github';
}

export function repositoryContextFacts(context: RepositoryContext): string {
  const facts = {
    source: context.source,
    repository: context.repository,
    readme: context.readme?.slice(0, 6000),
    directoryTree: context.directoryTree.slice(0, 250).map((entry) => entry.path),
    configurationFiles: context.configurationFiles.map((file) => ({
      path: file.path,
      content: file.content.slice(0, 3000),
    })),
    documentation: context.documentation.slice(0, 30),
    recentActivity: context.recentActivity,
    detected: context.detected,
  };
  return JSON.stringify(facts).slice(0, 30000);
}