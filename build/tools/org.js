import { z } from "zod/v4";
import { getOctokit } from "../github-client.js";
export function registerOrgTools(server) {
    // list_org_members
    server.registerTool("list_org_members", {
        title: "List Organization Members",
        description: "List all members of a GitHub organization",
        inputSchema: z.object({
            org: z.string().describe("GitHub organization name"),
        }),
    }, async ({ org }) => {
        const octokit = getOctokit();
        const members = await octokit.paginate(octokit.orgs.listMembers, {
            org,
            per_page: 100,
        });
        const result = members.map((m) => ({
            login: m.login,
            id: m.id,
            avatar_url: m.avatar_url,
            site_admin: m.site_admin,
        }));
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ total: result.length, members: result }, null, 2),
                },
            ],
        };
    });
    // list_org_teams
    server.registerTool("list_org_teams", {
        title: "List Organization Teams",
        description: "List all teams in a GitHub organization",
        inputSchema: z.object({
            org: z.string().describe("GitHub organization name"),
        }),
    }, async ({ org }) => {
        const octokit = getOctokit();
        const teams = await octokit.paginate(octokit.teams.list, {
            org,
            per_page: 100,
        });
        const result = teams.map((t) => ({
            name: t.name,
            slug: t.slug,
            description: t.description,
            privacy: t.privacy,
            permission: t.permission,
        }));
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ total: result.length, teams: result }, null, 2),
                },
            ],
        };
    });
    // list_team_members
    server.registerTool("list_team_members", {
        title: "List Team Members",
        description: "List all members of a specific team in a GitHub organization",
        inputSchema: z.object({
            org: z.string().describe("GitHub organization name"),
            team_slug: z.string().describe("Team slug (e.g., 'backend-team')"),
        }),
    }, async ({ org, team_slug }) => {
        const octokit = getOctokit();
        const members = await octokit.paginate(octokit.teams.listMembersInOrg, { org, team_slug, per_page: 100 });
        const result = members.map((m) => ({
            login: m.login,
            id: m.id,
            avatar_url: m.avatar_url,
        }));
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ team: team_slug, total: result.length, members: result }, null, 2),
                },
            ],
        };
    });
    // list_org_repos
    server.registerTool("list_org_repos", {
        title: "List Organization Repositories",
        description: "List all repositories in a GitHub organization with basic info",
        inputSchema: z.object({
            org: z.string().describe("GitHub organization name"),
            include_archived: z
                .boolean()
                .optional()
                .describe("Include archived repositories (default: false)"),
        }),
    }, async ({ org, include_archived }) => {
        const octokit = getOctokit();
        const repos = await octokit.paginate(octokit.repos.listForOrg, {
            org,
            per_page: 100,
            type: "all",
        });
        let filtered = repos;
        if (!include_archived) {
            filtered = repos.filter((r) => !r.archived);
        }
        const result = filtered.map((r) => ({
            name: r.name,
            full_name: r.full_name,
            language: r.language,
            private: r.private,
            archived: r.archived,
            stargazers_count: r.stargazers_count,
            updated_at: r.updated_at,
            description: r.description,
        }));
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ total: result.length, repos: result }, null, 2),
                },
            ],
        };
    });
}
