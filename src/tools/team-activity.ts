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

export function registerTeamActivityTools(server: McpServer) {
  server.registerTool(
    "get_team_activity",
    {
      title: "Get Team Activity Summary",
      description:
        "Get aggregated activity summary for all members of a team across organization repositories. " +
        "Shows commits, PRs, reviews, and LOC per member with team totals.",
      inputSchema: z.object({
        org: githubSlug.describe("GitHub organization name"),
        team_slug: githubSlug.describe("Team slug (e.g., 'backend-team')"),
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
            "Maximum repos to scan (default: 50, sorted by most recently updated)"
          ),
      }),
    },
    async ({ org, team_slug, since, until, max_repos }) => {
      const octokit = getOctokit();

      // 1. Get team members
      const teamMembers = await octokit.paginate(
        octokit.teams.listMembersInOrg,
        { org, team_slug, per_page: 100 }
      );
      const memberLogins = teamMembers.map((m) => m.login);

      if (memberLogins.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { team: team_slug, error: "Team has no members" },
                null,
                2
              ),
            },
          ],
        };
      }

      // 2. Get repos (capped)
      const allRepos = await getOrgRepos(org);
      let activeRepos = allRepos.filter((r) => !r.archived);
      const limit = max_repos ?? 50;
      activeRepos.sort((a, b) => {
        const aDate = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const bDate = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return bDate - aDate;
      });
      const totalActiveRepos = activeRepos.length;
      const wasTruncated = activeRepos.length > limit;
      activeRepos = activeRepos.slice(0, limit);

      await ensureRateLimit("core", activeRepos.length * 2 + memberLogins.length * 2);

      const sinceTs = since ? new Date(since).getTime() / 1000 : 0;
      const untilTs = until
        ? new Date(until).getTime() / 1000
        : Date.now() / 1000;

      // 3. Gather contributor stats per repo
      const memberSet = new Set(memberLogins.map((l) => l.toLowerCase()));

      type MemberStats = {
        commits: number;
        additions: number;
        deletions: number;
        activeRepos: Set<string>;
      };
      const memberStatsMap = new Map<string, MemberStats>();
      for (const login of memberLogins) {
        memberStatsMap.set(login.toLowerCase(), {
          commits: 0,
          additions: 0,
          deletions: 0,
          activeRepos: new Set(),
        });
      }

      const { errors } = await mapConcurrent(
        activeRepos,
        async (r) => {
          const stats = await fetchContributorStats(org, r.name);
          for (const contributor of stats) {
            const loginLower = contributor.author.login.toLowerCase();
            if (!memberSet.has(loginLower)) continue;
            const ms = memberStatsMap.get(loginLower)!;

            for (const week of contributor.weeks) {
              if (week.w >= sinceTs && week.w <= untilTs) {
                ms.commits += week.c;
                ms.additions += week.a;
                ms.deletions += week.d;
                if (week.c > 0) ms.activeRepos.add(r.name);
              }
            }
          }
          return null;
        },
        5,
        (r) => r.name
      );

      // 4. Search PRs authored and reviewed per member (batch via search)
      const prCounts = new Map<string, { authored: number; merged: number; reviewed: number }>();
      for (const login of memberLogins) {
        prCounts.set(login.toLowerCase(), { authored: 0, merged: 0, reviewed: 0 });
      }

      // Batch: one search per member for authored PRs
      const prWarnings: string[] = [];

      await mapConcurrent(
        memberLogins,
        async (login) => {
          try {
            let prQuery = `is:pr author:${login} org:${org}`;
            if (since) prQuery += ` created:>=${since}`;
            if (until) prQuery += ` created:<=${until}`;

            const prs = await octokit.paginate(
              "GET /search/issues",
              { q: prQuery, per_page: 100 },
              (response) => response.data
            );

            const entry = prCounts.get(login.toLowerCase())!;
            entry.authored = prs.length;
            entry.merged = prs.filter((p) => p.pull_request?.merged_at).length;
          } catch (err) {
            prWarnings.push(
              `Failed to fetch PRs for ${login}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          return null;
        },
        3 // lower concurrency for search API (30 req/min limit)
      );

      // Reviews per member
      await mapConcurrent(
        memberLogins,
        async (login) => {
          try {
            let reviewQuery = `is:pr reviewed-by:${login} org:${org}`;
            if (since) reviewQuery += ` created:>=${since}`;
            if (until) reviewQuery += ` created:<=${until}`;

            const reviews = await octokit.paginate(
              "GET /search/issues",
              { q: reviewQuery, per_page: 100 },
              (response) => response.data
            );
            prCounts.get(login.toLowerCase())!.reviewed = reviews.length;
          } catch (err) {
            prWarnings.push(
              `Failed to fetch reviews for ${login}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          return null;
        },
        3
      );

      // 5. Build per-member results
      const members = memberLogins.map((login) => {
        const ms = memberStatsMap.get(login.toLowerCase())!;
        const pr = prCounts.get(login.toLowerCase())!;
        return {
          login,
          commits: ms.commits,
          prs_authored: pr.authored,
          prs_merged: pr.merged,
          prs_reviewed: pr.reviewed,
          lines_added: ms.additions,
          lines_deleted: ms.deletions,
          net_lines: ms.additions - ms.deletions,
          active_repos_count: ms.activeRepos.size,
        };
      });

      // Sort by commits descending
      members.sort((a, b) => b.commits - a.commits);

      // Team totals
      const totals = members.reduce(
        (acc, m) => ({
          commits: acc.commits + m.commits,
          prs_authored: acc.prs_authored + m.prs_authored,
          prs_merged: acc.prs_merged + m.prs_merged,
          prs_reviewed: acc.prs_reviewed + m.prs_reviewed,
          lines_added: acc.lines_added + m.lines_added,
          lines_deleted: acc.lines_deleted + m.lines_deleted,
        }),
        {
          commits: 0,
          prs_authored: 0,
          prs_merged: 0,
          prs_reviewed: 0,
          lines_added: 0,
          lines_deleted: 0,
        }
      );

      const warnings: string[] = [...prWarnings];
      if (wasTruncated) {
        warnings.push(
          `Scanned ${limit} of ${totalActiveRepos} active repos (most recently updated). Use max_repos to increase.`
        );
      }
      for (const e of errors) {
        warnings.push(`Failed to fetch stats for ${e.item}: ${e.error}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                org,
                team: team_slug,
                period: { since: since ?? "all time", until: until ?? "now" },
                member_count: memberLogins.length,
                repos_scanned: activeRepos.length,
                totals: {
                  ...totals,
                  net_lines: totals.lines_added - totals.lines_deleted,
                },
                members,
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
