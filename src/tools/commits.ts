import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit, getOrgRepos } from "../github-client.js";
import { githubSlug, isoDate } from "./schemas.js";
import { mapConcurrent } from "../utils/concurrency.js";

export function registerCommitTools(server: McpServer) {
  server.registerTool(
    "get_user_commits",
    {
      title: "Get User Commits",
      description:
        "Get commit statistics for a specific user across organization repositories",
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
      const octokit = getOctokit();

      const repoNames = repo
        ? [repo]
        : (await getOrgRepos(org))
            .filter((r) => !r.archived)
            .map((r) => r.name);

      const repoStats = await mapConcurrent(
        repoNames,
        async (repoName) => {
          const commits = await octokit.paginate(octokit.repos.listCommits, {
            owner: org,
            repo: repoName,
            author: username,
            ...(since && { since }),
            ...(until && { until }),
            per_page: 100,
          });
          if (commits.length > 0) {
            return { repo: repoName, commits: commits.length };
          }
          return null;
        },
        5
      );

      const validStats = repoStats.filter(
        (s): s is { repo: string; commits: number } => s !== null
      );
      const totalCommits = validStats.reduce((sum, s) => sum + s.commits, 0);
      validStats.sort((a, b) => b.commits - a.commits);

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
                repos_with_commits: validStats.length,
                by_repo: validStats,
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
