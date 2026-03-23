import { Octokit } from "@octokit/rest";
export declare function getOctokit(): Octokit;
/**
 * Fetch contributor stats with retry logic for 202 responses.
 * GitHub returns 202 when stats are being computed in the background.
 */
export declare function fetchContributorStats(owner: string, repo: string, maxRetries?: number, delayMs?: number): Promise<ContributorStats[]>;
/**
 * Get all repos for an org, handling pagination automatically.
 */
export declare function getOrgRepos(org: string): Promise<OrgRepo[]>;
export interface ContributorStats {
    author: {
        login: string;
        id: number;
        avatar_url: string;
    };
    total: number;
    weeks: Array<{
        w: number;
        a: number;
        d: number;
        c: number;
    }>;
}
export interface OrgRepo {
    name: string;
    full_name: string;
    language: string | null;
    private: boolean;
    archived: boolean;
    updated_at: string | null;
    stargazers_count: number;
}
