import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getOctokit,
  fetchContributorStats,
  getOrgRepos,
  ensureRateLimit,
} from "../github-client.js";
import { githubSlug, isoDate } from "./schemas.js";
import { mapConcurrent } from "../utils/concurrency.js";
import { toUnixSeconds } from "../utils/dates.js";

export function registerContributionTools(server: McpServer) {
  // get_repo_contributors
  server.registerTool(
    "get_repo_contributors",
    {
      title: "Get Repository Contributors",
      description:
        "Get contributor rankings for a specific repository (commits, additions, deletions)",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        since: isoDate
          .optional()
          .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
        until: isoDate
          .optional()
          .describe("End date (ISO 8601, e.g., '2024-12-31')"),
      }),
    },
    async ({ owner, repo, since, until }) => {
      const stats = await fetchContributorStats(owner, repo);

      const sinceTs = toUnixSeconds(since);
      const untilTs = toUnixSeconds(until, Date.now() / 1000);

      const contributors = stats
        .map((s) => {
          let additions = 0;
          let deletions = 0;
          let commits = 0;

          for (const week of s.weeks) {
            if (week.w >= sinceTs && week.w <= untilTs) {
              additions += week.a;
              deletions += week.d;
              commits += week.c;
            }
          }

          return {
            login: s.author.login,
            commits,
            additions,
            deletions,
            net_lines: additions - deletions,
          };
        })
        .filter((c) => c.commits > 0)
        .sort((a, b) => b.commits - a.commits);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                period: { since: since ?? "all time", until: until ?? "now" },
                total_contributors: contributors.length,
                contributors,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // get_repo_stats
  server.registerTool(
    "get_repo_stats",
    {
      title: "Get Repository Stats",
      description:
        "Get overall statistics for a repository (commits, PRs, contributors, recent activity)",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        since: isoDate
          .optional()
          .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
        until: isoDate
          .optional()
          .describe("End date (ISO 8601, e.g., '2024-12-31')"),
      }),
    },
    async ({ owner, repo, since, until }) => {
      const octokit = getOctokit();

      // Get commits count
      const commitParams: Record<string, string> = {};
      if (since) commitParams.since = since;
      if (until) commitParams.until = until;

      const commits = await octokit.paginate(octokit.repos.listCommits, {
        owner,
        repo,
        per_page: 100,
        ...commitParams,
      });

      // Get PRs (owner validated by Zod regex)
      let prQuery = `is:pr repo:${owner}/${repo}`;
      if (since) prQuery += ` created:>=${since}`;
      if (until) prQuery += ` created:<=${until}`;

      const prs = await octokit.paginate(
        "GET /search/issues",
        { q: prQuery, per_page: 100 },
        (response) => response.data
      );

      const mergedPrs = prs.filter((p) => p.pull_request?.merged_at);
      const openPrs = prs.filter((p) => p.state === "open");

      // Get contributor stats
      const contribStats = await fetchContributorStats(owner, repo);
      const sinceTs = toUnixSeconds(since);
      const untilTs = toUnixSeconds(until, Date.now() / 1000);

      let totalAdditions = 0;
      let totalDeletions = 0;
      const activeContributors = new Set<string>();

      for (const s of contribStats) {
        let hasActivity = false;
        for (const week of s.weeks) {
          if (week.w >= sinceTs && week.w <= untilTs) {
            totalAdditions += week.a;
            totalDeletions += week.d;
            if (week.c > 0) hasActivity = true;
          }
        }
        if (hasActivity) activeContributors.add(s.author.login);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                period: { since: since ?? "all time", until: until ?? "now" },
                commits: commits.length,
                pull_requests: {
                  total: prs.length,
                  merged: mergedPrs.length,
                  open: openPrs.length,
                },
                contributors: activeContributors.size,
                lines_of_code: {
                  additions: totalAdditions,
                  deletions: totalDeletions,
                  net: totalAdditions - totalDeletions,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // get_member_activity
  server.registerTool(
    "get_member_activity",
    {
      title: "Get Member Activity Summary",
      description:
        "Get a comprehensive activity summary for a member across organization repositories (commits, PRs, reviews, LOC). " +
        "Use max_repos to limit scope for large organizations.",
      inputSchema: z.object({
        org: githubSlug.describe("GitHub organization name"),
        username: githubSlug.describe("GitHub username"),
        since: isoDate
          .optional()
          .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
        until: isoDate
          .optional()
          .describe("End date (ISO 8601, e.g., '2024-12-31')"),
        max_repos: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Maximum number of repos to scan (default: 50). " +
            "Repos are sorted by most recently updated first."
          ),
      }),
    },
    async ({ org, username, since, until, max_repos }) => {
      const octokit = getOctokit();
      const allRepos = await getOrgRepos(org);
      let activeRepos = allRepos.filter((r) => !r.archived);

      // Sort by most recently updated and cap
      const limit = max_repos ?? 50;
      activeRepos.sort((a, b) => {
        const aDate = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const bDate = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return bDate - aDate;
      });
      const totalActiveRepos = activeRepos.length;
      const wasTruncated = activeRepos.length > limit;
      activeRepos = activeRepos.slice(0, limit);

      // Check rate limit before expensive operation
      await ensureRateLimit("core", activeRepos.length * 2);

      const sinceTs = toUnixSeconds(since);
      const untilTs = toUnixSeconds(until, Date.now() / 1000);

      // LOC from contributor stats (parallelized)
      const { results: locResults, errors } = await mapConcurrent(
        activeRepos,
        async (r) => {
          const stats = await fetchContributorStats(org, r.name);
          const userStats = stats.find(
            (s) => s.author.login.toLowerCase() === username.toLowerCase()
          );
          if (!userStats) return null;

          let repoAdditions = 0;
          let repoDeletions = 0;
          let repoCommits = 0;

          for (const week of userStats.weeks) {
            if (week.w >= sinceTs && week.w <= untilTs) {
              repoAdditions += week.a;
              repoDeletions += week.d;
              repoCommits += week.c;
            }
          }

          if (repoCommits > 0) {
            return {
              name: r.name,
              additions: repoAdditions,
              deletions: repoDeletions,
              commits: repoCommits,
            };
          }
          return null;
        },
        5,
        (r) => r.name
      );

      let totalAdditions = 0;
      let totalDeletions = 0;
      let locCommits = 0;
      const activeRepoNames: string[] = [];

      for (const result of locResults) {
        if (result) {
          activeRepoNames.push(result.name);
          totalAdditions += result.additions;
          totalDeletions += result.deletions;
          locCommits += result.commits;
        }
      }

      // PRs authored (via search, username/org validated by Zod regex)
      let prQuery = `is:pr author:${username} org:${org}`;
      if (since) prQuery += ` created:>=${since}`;
      if (until) prQuery += ` created:<=${until}`;

      let totalPrs = 0;
      let mergedPrs = 0;
      let prError: string | null = null;
      try {
        const prs = await octokit.paginate(
          "GET /search/issues",
          { q: prQuery, per_page: 100 },
          (response) => response.data
        );
        totalPrs = prs.length;
        mergedPrs = prs.filter((p) => p.pull_request?.merged_at).length;
      } catch (err) {
        prError = err instanceof Error ? err.message : String(err);
      }

      // PRs reviewed
      let reviewQuery = `is:pr reviewed-by:${username} org:${org}`;
      if (since) reviewQuery += ` created:>=${since}`;
      if (until) reviewQuery += ` created:<=${until}`;

      let totalReviews = 0;
      let reviewError: string | null = null;
      try {
        const reviews = await octokit.paginate(
          "GET /search/issues",
          { q: reviewQuery, per_page: 100 },
          (response) => response.data
        );
        totalReviews = reviews.length;
      } catch (err) {
        reviewError = err instanceof Error ? err.message : String(err);
      }

      // Collect all warnings
      const warnings: string[] = [];
      if (wasTruncated) {
        warnings.push(
          `Scanned ${limit} of ${totalActiveRepos} active repos (most recently updated). ` +
          `Use max_repos to increase.`
        );
      }
      for (const e of errors) {
        warnings.push(`Failed to fetch stats for ${e.item}: ${e.error}`);
      }
      if (prError) warnings.push(`Failed to fetch PRs: ${prError}`);
      if (reviewError) warnings.push(`Failed to fetch reviews: ${reviewError}`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username,
                org,
                period: { since: since ?? "all time", until: until ?? "now" },
                repos_scanned: activeRepos.length,
                summary: {
                  commits: locCommits,
                  pull_requests_authored: totalPrs,
                  pull_requests_merged: mergedPrs,
                  pull_requests_reviewed: totalReviews,
                  lines_added: totalAdditions,
                  lines_deleted: totalDeletions,
                  net_lines: totalAdditions - totalDeletions,
                },
                active_repos: activeRepoNames,
                active_repos_count: activeRepoNames.length,
                ...(warnings.length > 0 && { warnings }),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
