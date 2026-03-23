#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { registerOrgTools } from "./tools/org.js";
import { registerCommitTools } from "./tools/commits.js";
import { registerPRTools } from "./tools/pull-requests.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerLOCTools } from "./tools/loc.js";
import { registerContributionTools } from "./tools/contributions.js";
function createMcpServer() {
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
async function startStdio() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("GitHub Org Monitor MCP server running on stdio");
}
async function startHttp(port) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
    });
    await server.connect(transport);
    const httpServer = createServer(async (req, res) => {
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        // Health check
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", server: "github-org-monitor" }));
            return;
        }
        // MCP endpoint
        if (req.url === "/mcp") {
            // Parse body for POST requests
            if (req.method === "POST") {
                const chunks = [];
                for await (const chunk of req) {
                    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
                }
                const body = JSON.parse(Buffer.concat(chunks).toString());
                await transport.handleRequest(req, res, body);
            }
            else {
                await transport.handleRequest(req, res);
            }
            return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });
    httpServer.listen(port, () => {
        console.error(`GitHub Org Monitor MCP server running on http://localhost:${port}/mcp`);
        console.error(`Health check: http://localhost:${port}/health`);
    });
}
// CLI argument parsing
const args = process.argv.slice(2);
const isHttp = args.includes("--http");
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3100;
if (isHttp) {
    startHttp(port).catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
else {
    startStdio().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
