import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit } from "../github-client.js";

export function registerReviewTools(server: McpServer) {
  server.registerTool(
    "get_user_reviews",
    {
      title: "Get User Code Reviews",
      description:
        "Get code review activity for a specific user in a GitHub organization",
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
          .describe("Specific repository name. If omitted, searches all org repos"),
      }),
    },
    async ({ org, username, since, until, repo }) => {
      const octokit = getOctokit();

      // Search for PRs reviewed by the user
      let query = `is:pr reviewed-by:${username} org:${org}`;
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

      // For each PR, get actual review details (limited to first 50 to manage rate limits)
      const prsToCheck = searchResults.slice(0, 50);
      let approvedCount = 0;
      let changesRequestedCount = 0;
      let commentedCount = 0;
      const byRepo: Record<string, number> = {};

      for (const pr of prsToCheck) {
        const repoName = pr.repository_url?.split("/").pop() ?? "unknown";
        byRepo[repoName] = (byRepo[repoName] ?? 0) + 1;

        try {
          const reviews = await octokit.pulls.listReviews({
            owner: org,
            repo: repoName,
            pull_number: pr.number,
            per_page: 100,
          });

          for (const review of reviews.data) {
            if (review.user?.login !== username) continue;
            switch (review.state) {
              case "APPROVED":
                approvedCount++;
                break;
              case "CHANGES_REQUESTED":
                changesRequestedCount++;
                break;
              case "COMMENTED":
                commentedCount++;
                break;
            }
          }
        } catch {
          // Skip if we can't access the PR
        }
      }

      const repoBreakdown = Object.entries(byRepo)
        .map(([name, count]) => ({ repo: name, reviews: count }))
        .sort((a, b) => b.reviews - a.reviews);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                username,
                org,
                period: { since: since ?? "all time", until: until ?? "now" },
                total_prs_reviewed: searchResults.length,
                review_details_checked: prsToCheck.length,
                approved: approvedCount,
                changes_requested: changesRequestedCount,
                commented: commentedCount,
                by_repo: repoBreakdown,
                note:
                  searchResults.length > 50
                    ? "Review details limited to first 50 PRs to manage API rate limits"
                    : undefined,
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
