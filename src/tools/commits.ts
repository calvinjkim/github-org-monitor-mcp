import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit, getOrgRepos } from "../github-client.js";

export function registerCommitTools(server: McpServer) {
  server.registerTool(
    "get_user_commits",
    {
      title: "Get User Commits",
      description:
        "Get commit statistics for a specific user across organization repositories",
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
      const octokit = getOctokit();

      const repoNames = repo
        ? [repo]
        : (await getOrgRepos(org))
            .filter((r) => !r.archived)
            .map((r) => r.name);

      const repoStats: Array<{ repo: string; commits: number }> = [];
      let totalCommits = 0;

      for (const repoName of repoNames) {
        try {
          const commits = await octokit.paginate(octokit.repos.listCommits, {
            owner: org,
            repo: repoName,
            author: username,
            ...(since && { since }),
            ...(until && { until }),
            per_page: 100,
          });

          if (commits.length > 0) {
            repoStats.push({ repo: repoName, commits: commits.length });
            totalCommits += commits.length;
          }
        } catch {
          // Skip repos with errors (e.g., empty repos)
        }
      }

      repoStats.sort((a, b) => b.commits - a.commits);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username,
                org,
                period: { since: since ?? "all time", until: until ?? "now" },
                total_commits: totalCommits,
                repos_with_commits: repoStats.length,
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
