import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit } from "../github-client.js";

export function registerPRTools(server: McpServer) {
  server.registerTool(
    "get_user_prs",
    {
      title: "Get User Pull Requests",
      description:
        "Get pull request statistics for a specific user in a GitHub organization",
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
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("PR state filter (default: 'all')"),
        repo: z
          .string()
          .optional()
          .describe("Specific repository name. If omitted, searches all org repos"),
      }),
    },
    async ({ org, username, since, until, state, repo }) => {
      const octokit = getOctokit();
      const stateFilter = state ?? "all";

      // Build search query
      let query = `is:pr author:${username} org:${org}`;
      if (stateFilter === "open") query += " is:open";
      else if (stateFilter === "closed") query += " is:closed";
      if (repo) query += ` repo:${org}/${repo}`;
      if (since) query += ` created:>=${since}`;
      if (until) query += ` created:<=${until}`;

      const searchResults = await octokit.paginate(
        "GET /search/issues",
        {
          q: query,
          per_page: 100,
        },
        (response) => response.data
      );

      let mergedCount = 0;
      let openCount = 0;
      let closedNotMergedCount = 0;
      const mergeTimes: number[] = [];
      const byRepo: Record<string, number> = {};

      for (const item of searchResults) {
        // Extract repo name from repository_url
        const repoName = item.repository_url?.split("/").pop() ?? "unknown";
        byRepo[repoName] = (byRepo[repoName] ?? 0) + 1;

        if (item.state === "open") {
          openCount++;
        } else if (item.pull_request?.merged_at) {
          mergedCount++;
          // Calculate merge time
          const created = new Date(item.created_at).getTime();
          const merged = new Date(item.pull_request.merged_at).getTime();
          mergeTimes.push((merged - created) / (1000 * 60 * 60)); // hours
        } else {
          closedNotMergedCount++;
        }
      }

      const avgMergeTimeHours =
        mergeTimes.length > 0
          ? Math.round(
              (mergeTimes.reduce((a, b) => a + b, 0) / mergeTimes.length) * 10
            ) / 10
          : null;

      const repoBreakdown = Object.entries(byRepo)
        .map(([name, count]) => ({ repo: name, prs: count }))
        .sort((a, b) => b.prs - a.prs);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username,
                org,
                period: { since: since ?? "all time", until: until ?? "now" },
                state_filter: stateFilter,
                total_prs: searchResults.length,
                open: openCount,
                merged: mergedCount,
                closed_not_merged: closedNotMergedCount,
                avg_merge_time_hours: avgMergeTimeHours,
                by_repo: repoBreakdown,
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
