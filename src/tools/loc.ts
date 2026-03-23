import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchContributorStats, getOrgRepos } from "../github-client.js";

export function registerLOCTools(server: McpServer) {
  server.registerTool(
    "get_user_loc",
    {
      title: "Get User Lines of Code",
      description:
        "Get lines of code (additions/deletions) for a specific user across organization repositories",
      inputSchema: z.object({
        org: z.string().describe("GitHub organization name"),
        username: z.string().describe("GitHub username"),
        since: z
          .string()
          .optional()
          .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
        until: z
          .string()
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

      const sinceTs = since ? new Date(since).getTime() / 1000 : 0;
      const untilTs = until
        ? new Date(until).getTime() / 1000
        : Date.now() / 1000;

      const repoStats: Array<{
        repo: string;
        additions: number;
        deletions: number;
        commits: number;
      }> = [];
      let totalAdditions = 0;
      let totalDeletions = 0;
      let totalCommits = 0;

      for (const repoName of repoNames) {
        try {
          const stats = await fetchContributorStats(org, repoName);
          const userStats = stats.find(
            (s) => s.author.login.toLowerCase() === username.toLowerCase()
          );

          if (!userStats) continue;

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
            repoStats.push({ repo: repoName, additions, deletions, commits });
            totalAdditions += additions;
            totalDeletions += deletions;
            totalCommits += commits;
          }
        } catch {
          // Skip repos with errors
        }
      }

      repoStats.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

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
                repos_with_changes: repoStats.length,
                by_repo: repoStats,
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
