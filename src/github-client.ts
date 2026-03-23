import { Octokit } from "@octokit/rest";
import { AsyncLocalStorage } from "node:async_hooks";

// Per-request context store
interface RequestContext {
  token: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Cache Octokit instances by token to avoid re-creating per call within same request
const octokitCache = new Map<string, Octokit>();

export function getOctokit(): Octokit {
  // 1. Try AsyncLocalStorage context (Lambda per-request token)
  const ctx = requestContext.getStore();
  if (ctx?.token) {
    let octokit = octokitCache.get(ctx.token);
    if (!octokit) {
      octokit = new Octokit({
        auth: ctx.token,
        userAgent: "github-org-monitor-mcp/1.0.0",
      });
      octokitCache.set(ctx.token, octokit);
      // Evict old entries if cache grows too large
      if (octokitCache.size > 100) {
        const firstKey = octokitCache.keys().next().value;
        if (firstKey) octokitCache.delete(firstKey);
      }
    }
    return octokit;
  }

  // 2. Fallback to GITHUB_TOKEN env var (stdio/local HTTP mode)
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN environment variable is required. " +
      "Create a Personal Access Token at https://github.com/settings/tokens " +
      "with 'repo', 'read:org' scopes."
    );
  }

  let octokit = octokitCache.get(token);
  if (!octokit) {
    octokit = new Octokit({
      auth: token,
      userAgent: "github-org-monitor-mcp/1.0.0",
    });
    octokitCache.set(token, octokit);
  }
  return octokit;
}

/**
 * Fetch contributor stats with retry logic for 202 responses.
 * GitHub returns 202 when stats are being computed in the background.
 */
export async function fetchContributorStats(
  owner: string,
  repo: string,
  maxRetries = 3,
  delayMs = 2000
): Promise<ContributorStats[]> {
  const octokit = getOctokit();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/stats/contributors",
      { owner, repo }
    );

    if (response.status === 200 && Array.isArray(response.data)) {
      return response.data as ContributorStats[];
    }

    // 202 means stats are being computed
    if (response.status === 202 && attempt < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return [];
}

/**
 * Get all repos for an org, handling pagination automatically.
 */
export async function getOrgRepos(org: string): Promise<OrgRepo[]> {
  const octokit = getOctokit();
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all",
  });
  return repos.map((r) => ({
    name: r.name,
    full_name: r.full_name,
    language: r.language ?? null,
    private: r.private,
    archived: r.archived ?? false,
    updated_at: r.updated_at ?? null,
    stargazers_count: r.stargazers_count ?? 0,
  }));
}

// Types

export interface ContributorStats {
  author: {
    login: string;
    id: number;
    avatar_url: string;
  };
  total: number;
  weeks: Array<{
    w: number; // Unix timestamp for start of week
    a: number; // additions
    d: number; // deletions
    c: number; // commits
  }>;
}

export interface OrgRepo {
  name: string;
  full_name: string;
  language: string | null;
  private: boolean;
  archived: boolean;
  updated_at: string | null;
  stargazers_count: number;
}
