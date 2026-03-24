import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchContributorStats, getOrgRepos } from "../github-client.js";
import { githubSlug, isoDate } from "./schemas.js";
import { mapConcurrent } from "../utils/concurrency.js";
import { toUnixSeconds } from "../utils/dates.js";

export function registerLOCTools(server: McpServer) {
  server.registerTool(
    "get_user_loc",
    {
      title: "Get User Lines of Code",
      description:
        "Get lines of code (additions/deletions) for a specific user across organization repositories",
      inputSchema: z.object({
        org: githubSlug.describe("GitHub organization name"),
        username: githubSlug.describe("GitHub username"),
        since: isoDate
          .optional()
          .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
        until: isoDate
          .optional()
          .describe("End date (ISO 8601, e.g., '2024-12-31')"),
        repo: z
          .string()
          .optional()
          .describe(
            "Specific repository name. If omitted, searches all org repos"
          ),
      }),
    },
    async ({ org, username, since, until, repo }) => {
      const repoNames = repo
        ? [repo]
        : (await getOrgRepos(org))
            .filter((r) => !r.archived)
            .map((r) => r.name);

      const sinceTs = toUnixSeconds(since);
      const untilTs = toUnixSeconds(until, Date.now() / 1000);

      const { results: repoStats, errors } = await mapConcurrent(
        repoNames,
        async (repoName) => {
          const stats = await fetchContributorStats(org, repoName);
          const userStats = stats.find(
            (s) => s.author.login.toLowerCase() === username.toLowerCase()
          );
          if (!userStats) return null;

          let additions = 0;
          let deletions = 0;
          let commits = 0;

          for (const week of userStats.weeks) {
            if (week.w >= sinceTs && week.w <= untilTs) {
              additions += week.a;
              deletions += week.d;
              commits += week.c;
            }
          }

          if (additions > 0 || deletions > 0 || commits > 0) {
            return { repo: repoName, additions, deletions, commits };
          }
          return null;
        },
        5,
        (name) => name
      );

      const validStats = repoStats.filter(
        (s): s is { repo: string; additions: number; deletions: number; commits: number } =>
          s !== null
      );

      let totalAdditions = 0;
      let totalDeletions = 0;
      let totalCommits = 0;
      for (const s of validStats) {
        totalAdditions += s.additions;
        totalDeletions += s.deletions;
        totalCommits += s.commits;
      }

      validStats.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username,
                org,
                period: { since: since ?? "all time", until: until ?? "now" },
                total_additions: totalAdditions,
                total_deletions: totalDeletions,
                net_lines: totalAdditions - totalDeletions,
                total_commits: totalCommits,
                repos_with_changes: validStats.length,
                by_repo: validStats,
                ...(errors.length > 0 && {
                  warnings: errors.map(
                    (e) => `Failed to fetch ${e.item}: ${e.error}`
                  ),
                }),
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
