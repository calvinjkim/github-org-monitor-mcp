import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { handleOAuthRequest } from "./oauth/handler.js";
import { handleMcpRequest } from "./mcp/handler.js";

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // CORS preflight
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
      },
    };
  }

  // Health check
  if (path === "/health" && method === "GET") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok", server: "github-org-monitor" }),
    };
  }

  // MCP endpoint
  if (path === "/mcp" && method === "POST") {
    const result = await handleMcpRequest({
      headers: event.headers as Record<string, string>,
      body: event.body || "",
    });
    return {
      statusCode: result.statusCode,
      headers: {
        "Access-Control-Allow-Origin": "*",
        ...result.headers,
      },
      body: result.body,
    };
  }

  // OAuth endpoints
  const oauthPaths = [
    "/.well-known/oauth-authorization-server",
    "/authorize",
    "/callback",
    "/token",
  ];

  if (oauthPaths.includes(path)) {
    const result = await handleOAuthRequest({
      method,
      path,
      queryStringParameters: event.queryStringParameters as Record<string, string>,
      body: event.body,
      headers: event.headers as Record<string, string>,
    });
    return {
      statusCode: result.statusCode,
      headers: {
        "Access-Control-Allow-Origin": "*",
        ...result.headers,
      },
      body: result.body,
    };
  }

  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Not found" }),
  };
}
