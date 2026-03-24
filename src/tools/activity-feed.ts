import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit } from "../github-client.js";
import { githubSlug } from "./schemas.js";

export function registerActivityFeedTools(server: McpServer) {
  // get_org_activity
  server.registerTool(
    "get_org_activity",
    {
      title: "Get Organization Activity Feed",
      description:
        "Get recent activity events for a GitHub organization. " +
        "Shows pushes, PR activity, issue events, releases, and more. " +
        "GitHub returns up to 90 days / 300 events.",
      inputSchema: z.object({
        org: githubSlug.describe("GitHub organization name"),
        per_page: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Events per page (default: 30, max: 100)"),
        event_types: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by event types (e.g., ['PushEvent', 'PullRequestEvent', 'IssuesEvent']). " +
            "Common types: PushEvent, PullRequestEvent, PullRequestReviewEvent, " +
            "IssuesEvent, IssueCommentEvent, CreateEvent, DeleteEvent, " +
            "ReleaseEvent, ForkEvent, WatchEvent"
          ),
      }),
    },
    async ({ org, per_page, event_types }) => {
      const octokit = getOctokit();
      const { data } = await octokit.activity.listPublicOrgEvents({
        org,
        per_page: per_page ?? 30,
      });

      let events = data;
      if (event_types && event_types.length > 0) {
        const typeSet = new Set(event_types);
        events = events.filter((e) => e.type && typeSet.has(e.type));
      }

      const formatted = events.map((e) => {
        const base = {
          type: e.type,
          actor: e.actor?.login,
          repo: e.repo?.name,
          created_at: e.created_at,
        };

        const payload = e.payload as Record<string, unknown>;

        switch (e.type) {
          case "PushEvent":
            return {
              ...base,
              ref: payload.ref,
              commits: (payload.commits as Array<{ message: string; author: { name: string } }>)
                ?.slice(0, 5)
                .map((c) => ({
                  message: c.message?.split("\n")[0],
                  author: c.author?.name,
                })),
              size: payload.size,
            };

          case "PullRequestEvent":
            return {
              ...base,
              action: payload.action,
              pr_number: (payload.pull_request as { number: number })?.number,
              pr_title: (payload.pull_request as { title: string })?.title,
              merged: (payload.pull_request as { merged: boolean })?.merged,
            };

          case "PullRequestReviewEvent":
            return {
              ...base,
              action: payload.action,
              review_state: (payload.review as { state: string })?.state,
              pr_number: (payload.pull_request as { number: number })?.number,
              pr_title: (payload.pull_request as { title: string })?.title,
            };

          case "IssuesEvent":
            return {
              ...base,
              action: payload.action,
              issue_number: (payload.issue as { number: number })?.number,
              issue_title: (payload.issue as { title: string })?.title,
            };

          case "IssueCommentEvent":
            return {
              ...base,
              action: payload.action,
              issue_number: (payload.issue as { number: number })?.number,
              issue_title: (payload.issue as { title: string })?.title,
              comment_body: ((payload.comment as { body: string })?.body || "").substring(0, 200),
            };

          case "CreateEvent":
            return {
              ...base,
              ref_type: payload.ref_type,
              ref: payload.ref,
            };

          case "DeleteEvent":
            return {
              ...base,
              ref_type: payload.ref_type,
              ref: payload.ref,
            };

          case "ReleaseEvent":
            return {
              ...base,
              action: payload.action,
              release_name: (payload.release as { name: string })?.name,
              tag: (payload.release as { tag_name: string })?.tag_name,
              prerelease: (payload.release as { prerelease: boolean })?.prerelease,
            };

          case "ForkEvent":
            return {
              ...base,
              forkee: (payload.forkee as { full_name: string })?.full_name,
            };

          default:
            return {
              ...base,
              action: payload.action ?? null,
            };
        }
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                org,
                total: formatted.length,
                events: formatted,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // get_repo_activity
  server.registerTool(
    "get_repo_activity",
    {
      title: "Get Repository Activity Feed",
      description:
        "Get recent activity events for a specific repository. " +
        "Shows pushes, PRs, issues, releases, and more.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        per_page: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Events per page (default: 30, max: 100)"),
        event_types: z
          .array(z.string())
          .optional()
          .describe("Filter by event types (e.g., ['PushEvent', 'PullRequestEvent'])"),
      }),
    },
    async ({ owner, repo, per_page, event_types }) => {
      const octokit = getOctokit();
      const { data } = await octokit.activity.listRepoEvents({
        owner,
        repo,
        per_page: per_page ?? 30,
      });

      let events = data;
      if (event_types && event_types.length > 0) {
        const typeSet = new Set(event_types);
        events = events.filter((e) => e.type && typeSet.has(e.type));
      }

      const formatted = events.map((e) => {
        const payload = e.payload as Record<string, unknown>;
        return {
          type: e.type,
          actor: e.actor?.login,
          created_at: e.created_at,
          action: payload.action ?? null,
          ...(e.type === "PushEvent" && {
            ref: payload.ref,
            commits: (payload.commits as Array<{ message: string; author: { name: string } }>)
              ?.slice(0, 5)
              .map((c) => ({
                message: c.message?.split("\n")[0],
                author: c.author?.name,
              })),
          }),
          ...(e.type === "PullRequestEvent" && {
            pr_number: (payload.pull_request as { number: number })?.number,
            pr_title: (payload.pull_request as { title: string })?.title,
          }),
          ...(e.type === "IssuesEvent" && {
            issue_number: (payload.issue as { number: number })?.number,
            issue_title: (payload.issue as { title: string })?.title,
          }),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                total: formatted.length,
                events: formatted,
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
