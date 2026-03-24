import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrgTools } from "./tools/org.js";
import { registerCommitTools } from "./tools/commits.js";
import { registerPRTools } from "./tools/pull-requests.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerLOCTools } from "./tools/loc.js";
import { registerContributionTools } from "./tools/contributions.js";

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

  return server;
}
