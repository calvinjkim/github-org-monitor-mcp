import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { verifyMcpToken } from "../oauth/tokens.js";
import { getUserToken, saveUserToken } from "../storage/dynamo.js";
import { refreshGitHubToken } from "../oauth/github-app.js";
import { requestContext } from "../github-client.js";
import { createMcpServer } from "../server.js";

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

async function ensureValidGitHubToken(githubUserId: string): Promise<string> {
  const userToken = await getUserToken(githubUserId);
  if (!userToken) {
    throw new Error("No GitHub token found. Please re-authenticate.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (userToken.expiresAt > now + 300) {
    return userToken.accessToken;
  }

  if (!userToken.refreshToken) {
    throw new Error("Token expired and no refresh token available. Please re-authenticate.");
  }

  const refreshed = await refreshGitHubToken(userToken.refreshToken);
  const newExpiresAt = refreshed.expires_in
    ? now + refreshed.expires_in
    : now + 8 * 60 * 60;

  await saveUserToken({
    githubUserId,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || userToken.refreshToken,
    expiresAt: newExpiresAt,
  });

  return refreshed.access_token;
}

export interface McpLambdaRequest {
  headers: Record<string, string>;
  body: string;
}

export interface McpLambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handleMcpRequest(
  req: McpLambdaRequest
): Promise<McpLambdaResponse> {
  // 1. Verify MCP JWT token
  const bearerToken = extractBearerToken(
    req.headers["authorization"] || req.headers["Authorization"]
  );
  if (!bearerToken) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing Authorization header" }),
    };
  }

  let payload;
  try {
    payload = verifyMcpToken(bearerToken);
  } catch {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid or expired token" }),
    };
  }

  // 2. Get valid GitHub token (refresh if needed)
  let githubToken: string;
  try {
    githubToken = await ensureValidGitHubToken(payload.sub);
  } catch (err) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: err instanceof Error ? err.message : "Token error",
      }),
    };
  }

  // 3. Run MCP request within AsyncLocalStorage context
  return new Promise((resolve) => {
    requestContext.run({ token: githubToken }, async () => {
      try {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        await server.connect(transport);

        const bodyObj = JSON.parse(req.body);

        const chunks: Buffer[] = [];
        let responseHeaders: Record<string, string> = {};
        let responseStatus = 200;

        const mockRes = {
          writeHead(status: number, headers?: Record<string, string | string[]>) {
            responseStatus = status;
            if (headers) {
              for (const [k, v] of Object.entries(headers)) {
                responseHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
              }
            }
            return this;
          },
          setHeader(name: string, value: string) {
            responseHeaders[name] = value;
          },
          getHeader(name: string) {
            return responseHeaders[name];
          },
          end(data?: string | Buffer) {
            if (data) {
              chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            }
            resolve({
              statusCode: responseStatus,
              headers: { "Content-Type": "application/json", ...responseHeaders },
              body: Buffer.concat(chunks).toString(),
            });
          },
          write(data: string | Buffer) {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            return true;
          },
          on() { return this; },
          once() { return this; },
          emit() { return false; },
          removeListener() { return this; },
        } as unknown as ServerResponse;

        const mockReq = {
          method: "POST",
          url: "/mcp",
          headers: { "content-type": "application/json", ...req.headers },
          on() { return this; },
          once() { return this; },
          emit() { return false; },
          removeListener() { return this; },
        } as unknown as IncomingMessage;

        await transport.handleRequest(mockReq, mockRes, bodyObj);
      } catch (err) {
        resolve({
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: err instanceof Error ? err.message : "Internal error",
          }),
        });
      }
    });
  });
}
