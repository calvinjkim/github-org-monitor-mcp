import { z } from "zod/v4";
import { getOctokit, fetchContributorStats, getOrgRepos, } from "../github-client.js";
export function registerContributionTools(server) {
    // get_repo_contributors
    server.registerTool("get_repo_contributors", {
        title: "Get Repository Contributors",
        description: "Get contributor rankings for a specific repository (commits, additions, deletions)",
        inputSchema: z.object({
            owner: z
                .string()
                .describe("Repository owner (organization or user)"),
            repo: z.string().describe("Repository name"),
            since: z
                .string()
                .optional()
                .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
            until: z
                .string()
                .optional()
                .describe("End date (ISO 8601, e.g., '2024-12-31')"),
        }),
    }, async ({ owner, repo, since, until }) => {
        const stats = await fetchContributorStats(owner, repo);
        const sinceTs = since ? new Date(since).getTime() / 1000 : 0;
        const untilTs = until
            ? new Date(until).getTime() / 1000
            : Date.now() / 1000;
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
                    type: "text",
                    text: JSON.stringify({
                        repo: `${owner}/${repo}`,
                        period: { since: since ?? "all time", until: until ?? "now" },
                        total_contributors: contributors.length,
                        contributors,
                    }, null, 2),
                },
            ],
        };
    });
    // get_repo_stats
    server.registerTool("get_repo_stats", {
        title: "Get Repository Stats",
        description: "Get overall statistics for a repository (commits, PRs, contributors, recent activity)",
        inputSchema: z.object({
            owner: z
                .string()
                .describe("Repository owner (organization or user)"),
            repo: z.string().describe("Repository name"),
            since: z
                .string()
                .optional()
                .describe("Start date (ISO 8601, e.g., '2024-01-01')"),
            until: z
                .string()
                .optional()
                .describe("End date (ISO 8601, e.g., '2024-12-31')"),
        }),
    }, async ({ owner, repo, since, until }) => {
        const octokit = getOctokit();
        // Get commits count
        const commitParams = {};
        if (since)
            commitParams.since = since;
        if (until)
            commitParams.until = until;
        const commits = await octokit.paginate(octokit.repos.listCommits, {
            owner,
            repo,
            per_page: 100,
            ...commitParams,
        });
        // Get PRs
        let prQuery = `is:pr repo:${owner}/${repo}`;
        if (since)
            prQuery += ` created:>=${since}`;
        if (until)
            prQuery += ` created:<=${until}`;
        const prs = await octokit.paginate("GET /search/issues", { q: prQuery, per_page: 100 }, (response) => response.data);
        const mergedPrs = prs.filter((p) => p.pull_request?.merged_at);
        const openPrs = prs.filter((p) => p.state === "open");
        // Get contributor stats
        const contribStats = await fetchContributorStats(owner, repo);
        const sinceTs = since ? new Date(since).getTime() / 1000 : 0;
        const untilTs = until
            ? new Date(until).getTime() / 1000
            : Date.now() / 1000;
        let totalAdditions = 0;
        let totalDeletions = 0;
        const activeContributors = new Set();
        for (const s of contribStats) {
            let hasActivity = false;
            for (const week of s.weeks) {
                if (week.w >= sinceTs && week.w <= untilTs) {
                    totalAdditions += week.a;
                    totalDeletions += week.d;
                    if (week.c > 0)
                        hasActivity = true;
                }
            }
            if (hasActivity)
                activeContributors.add(s.author.login);
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
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
                    }, null, 2),
                },
            ],
        };
    });
    // get_member_activity
    server.registerTool("get_member_activity", {
        title: "Get Member Activity Summary",
        description: "Get a comprehensive activity summary for a member across all organization repositories (commits, PRs, reviews, LOC)",
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
        }),
    }, async ({ org, username, since, until }) => {
        const octokit = getOctokit();
        const repos = await getOrgRepos(org);
        const activeRepos = repos.filter((r) => !r.archived);
        const sinceTs = since ? new Date(since).getTime() / 1000 : 0;
        const untilTs = until
            ? new Date(until).getTime() / 1000
            : Date.now() / 1000;
        // LOC from contributor stats
        let totalAdditions = 0;
        let totalDeletions = 0;
        let locCommits = 0;
        const activeRepoNames = [];
        for (const r of activeRepos) {
            try {
                const stats = await fetchContributorStats(org, r.name);
                const userStats = stats.find((s) => s.author.login.toLowerCase() === username.toLowerCase());
                if (!userStats)
                    continue;
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
                    activeRepoNames.push(r.name);
                    totalAdditions += repoAdditions;
                    totalDeletions += repoDeletions;
                    locCommits += repoCommits;
                }
            }
            catch {
                // Skip
            }
        }
        // PRs authored (via search)
        let prQuery = `is:pr author:${username} org:${org}`;
        if (since)
            prQuery += ` created:>=${since}`;
        if (until)
            prQuery += ` created:<=${until}`;
        let totalPrs = 0;
        let mergedPrs = 0;
        try {
            const prs = await octokit.paginate("GET /search/issues", { q: prQuery, per_page: 100 }, (response) => response.data);
            totalPrs = prs.length;
            mergedPrs = prs.filter((p) => p.pull_request?.merged_at).length;
        }
        catch {
            // Search API rate limit
        }
        // PRs reviewed
        let reviewQuery = `is:pr reviewed-by:${username} org:${org}`;
        if (since)
            reviewQuery += ` created:>=${since}`;
        if (until)
            reviewQuery += ` created:<=${until}`;
        let totalReviews = 0;
        try {
            const reviews = await octokit.paginate("GET /search/issues", { q: reviewQuery, per_page: 100 }, (response) => response.data);
            totalReviews = reviews.length;
        }
        catch {
            // Search API rate limit
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        username,
                        org,
                        period: { since: since ?? "all time", until: until ?? "now" },
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
                    }, null, 2),
                },
            ],
        };
    });
}
