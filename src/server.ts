import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrgTools } from "./tools/org.js";
import { registerCommitTools } from "./tools/commits.js";
import { registerPRTools } from "./tools/pull-requests.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerLOCTools } from "./tools/loc.js";
import { registerContributionTools } from "./tools/contributions.js";
import { registerRepoContentTools } from "./tools/repo-content.js";
import { registerIssuePRDetailTools } from "./tools/issues-prs.js";
import { registerBranchTools } from "./tools/branches.js";
import { registerTeamActivityTools } from "./tools/team-activity.js";
import { registerActivityFeedTools } from "./tools/activity-feed.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "github-org-monitor",
    version: "1.0.0",
  });

  registerOrgTools(server);
  registerCommitTools(server);
  registerPRTools(server);
  registerReviewTools(server);
  registerLOCTools(server);
  registerContributionTools(server);
  registerRepoContentTools(server);
  registerIssuePRDetailTools(server);
  registerBranchTools(server);
  registerTeamActivityTools(server);
  registerActivityFeedTools(server);

  return server;
}
