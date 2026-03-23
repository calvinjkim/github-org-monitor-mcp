# AWS Lambda + OAuth MCP Deployment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the GitHub Org Monitor MCP server to AWS Lambda with GitHub App OAuth 2.1 so team members can use it from claude.ai with their own GitHub permissions.

**Architecture:** Single Lambda function behind API Gateway HTTP API. OAuth 2.1 endpoints handle GitHub App authentication with PKCE. DynamoDB stores user tokens and in-flight auth codes. AsyncLocalStorage in `github-client.ts` provides per-request token isolation without changing tool files.

**Tech Stack:** Node.js 20.x, AWS SAM, DynamoDB, GitHub App OAuth, JWT, AsyncLocalStorage

**Spec:** `docs/superpowers/specs/2026-03-23-aws-oauth-mcp-deployment-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/github-client.ts` | Modify | AsyncLocalStorage context for per-request Octokit |
| `src/storage/dynamo.ts` | Create | DynamoDB CRUD for user tokens and auth codes |
| `src/oauth/tokens.ts` | Create | JWT issue/verify, PKCE S256, auth code generation |
| `src/oauth/github-app.ts` | Create | GitHub App token exchange and refresh |
| `src/oauth/membership.ts` | Create | Org membership verification |
| `src/oauth/handler.ts` | Create | OAuth endpoint routing (metadata, authorize, callback, token) |
| `src/mcp/handler.ts` | Create | MCP Streamable HTTP handler with auth middleware |
| `src/lambda.ts` | Create | Lambda entry point (API Gateway event → router) |
| `src/index.ts` | Modify | Keep stdio/http modes, remove Lambda concern |
| `infra/template.yaml` | Create | SAM template (Lambda, API Gateway, DynamoDB) |
| `package.json` | Modify | Add dependencies |
| `tsconfig.json` | Modify | Add `"esModuleInterop": true` already set, no change needed |

---

## Chunk 1: Foundation — AsyncLocalStorage + DynamoDB

### Task 1: Install new dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install production dependencies**

```bash
cd "/Users/juhyunkim/github mcp"
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb jsonwebtoken
```

- [ ] **Step 2: Install dev dependencies**

```bash
npm install --save-dev @types/jsonwebtoken @types/aws-lambda
```

- [ ] **Step 3: Verify build still works**

```bash
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add AWS SDK, JWT, and Lambda type dependencies"
```

---

### Task 2: Refactor github-client.ts with AsyncLocalStorage

This is the most critical change. Replace the singleton with AsyncLocalStorage so `getOctokit()` returns a per-request Octokit instance without changing any tool files.

**Files:**
- Modify: `src/github-client.ts`

- [ ] **Step 1: Implement AsyncLocalStorage-based getOctokit**

Replace the entire `getOctokit` function and singleton with:

```typescript
import { Octokit } from "@octokit/rest";
import { AsyncLocalStorage } from "node:async_hooks";

// Per-request context store
interface RequestContext {
  token: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Cache Octokit instances by token to avoid re-creating per call within same request
const octokitCache = new Map<string, Octokit>();

export function getOctokit(): Octokit {
  // 1. Try AsyncLocalStorage context (Lambda per-request token)
  const ctx = requestContext.getStore();
  if (ctx?.token) {
    let octokit = octokitCache.get(ctx.token);
    if (!octokit) {
      octokit = new Octokit({
        auth: ctx.token,
        userAgent: "github-org-monitor-mcp/1.0.0",
      });
      octokitCache.set(ctx.token, octokit);
      // Evict old entries if cache grows too large
      if (octokitCache.size > 100) {
        const firstKey = octokitCache.keys().next().value;
        if (firstKey) octokitCache.delete(firstKey);
      }
    }
    return octokit;
  }

  // 2. Fallback to GITHUB_TOKEN env var (stdio/local HTTP mode)
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN environment variable is required. " +
      "Create a Personal Access Token at https://github.com/settings/tokens " +
      "with 'repo', 'read:org' scopes."
    );
  }

  let octokit = octokitCache.get(token);
  if (!octokit) {
    octokit = new Octokit({
      auth: token,
      userAgent: "github-org-monitor-mcp/1.0.0",
    });
    octokitCache.set(token, octokit);
  }
  return octokit;
}
```

Keep `fetchContributorStats`, `getOrgRepos`, and all type exports unchanged — they already call `getOctokit()` internally.

- [ ] **Step 2: Verify build succeeds**

```bash
npm run build
```

Expected: Build succeeds. All tool files compile without changes since `getOctokit` signature is unchanged.

- [ ] **Step 3: Verify stdio mode still works**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | GITHUB_TOKEN=test node build/index.js 2>/dev/null | head -1
```

Expected: JSON response with server capabilities (proves stdio transport still initializes).

- [ ] **Step 4: Commit**

```bash
git add src/github-client.ts
git commit -m "refactor: replace Octokit singleton with AsyncLocalStorage context

getOctokit() now reads token from AsyncLocalStorage per-request context,
falling back to GITHUB_TOKEN env var for stdio/local modes.
Tool files unchanged — same function signature."
```

---

### Task 3: Create DynamoDB storage module

**Files:**
- Create: `src/storage/dynamo.ts`

- [ ] **Step 1: Create the storage module**

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

function getTableName(): string {
  return process.env.TOKEN_TABLE || "mcp-github-tokens";
}

// --- User tokens (pk: "user#{github_user_id}") ---

export interface UserToken {
  githubUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
}

export async function saveUserToken(token: UserToken): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days
  await docClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        pk: `user#${token.githubUserId}`,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        ttl,
      },
    })
  );
}

export async function getUserToken(
  githubUserId: string
): Promise<UserToken | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: getTableName(),
      Key: { pk: `user#${githubUserId}` },
    })
  );
  if (!result.Item) return null;
  return {
    githubUserId,
    accessToken: result.Item.accessToken as string,
    refreshToken: result.Item.refreshToken as string,
    expiresAt: result.Item.expiresAt as number,
  };
}

// --- Auth codes (pk: "auth#{code}") ---

export interface AuthCode {
  code: string;
  codeChallenge: string;
  githubUserId: string;
  redirectUri: string;
}

export async function saveAuthCode(authCode: AuthCode): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
  await docClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        pk: `auth#${authCode.code}`,
        codeChallenge: authCode.codeChallenge,
        githubUserId: authCode.githubUserId,
        redirectUri: authCode.redirectUri,
        ttl,
      },
    })
  );
}

export async function getAndDeleteAuthCode(
  code: string
): Promise<AuthCode | null> {
  const key = { pk: `auth#${code}` };
  const result = await docClient.send(
    new GetCommand({ TableName: getTableName(), Key: key })
  );
  if (!result.Item) return null;

  // Delete immediately (one-time use)
  await docClient.send(
    new DeleteCommand({ TableName: getTableName(), Key: key })
  );

  return {
    code,
    codeChallenge: result.Item.codeChallenge as string,
    githubUserId: result.Item.githubUserId as string,
    redirectUri: result.Item.redirectUri as string,
  };
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/storage/dynamo.ts
git commit -m "feat: add DynamoDB storage for user tokens and auth codes"
```

---

## Chunk 2: OAuth 2.1 Implementation

### Task 4: Create JWT and PKCE token utilities

**Files:**
- Create: `src/oauth/tokens.ts`

- [ ] **Step 1: Create the tokens module**

```typescript
import { randomBytes, createHash } from "node:crypto";
import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

// --- MCP JWT tokens ---

export interface McpTokenPayload {
  sub: string; // GitHub user ID
  iss: string; // Issuer URL
}

export function issueMcpToken(githubUserId: string, issuer: string): string {
  return jwt.sign({ sub: githubUserId, iss: issuer } as McpTokenPayload, getJwtSecret(), {
    expiresIn: "24h",
  });
}

export function verifyMcpToken(token: string): McpTokenPayload {
  return jwt.verify(token, getJwtSecret()) as McpTokenPayload;
}

// --- PKCE S256 ---

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string
): boolean {
  const hash = createHash("sha256").update(codeVerifier).digest("base64url");
  return hash === codeChallenge;
}

// --- Authorization code ---

export function generateAuthCode(): string {
  return randomBytes(32).toString("hex");
}

// --- State parameter ---

export function generateState(): string {
  return randomBytes(16).toString("hex");
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/oauth/tokens.ts
git commit -m "feat: add JWT, PKCE, and auth code utilities"
```

---

### Task 5: Create GitHub App OAuth module

**Files:**
- Create: `src/oauth/github-app.ts`

- [ ] **Step 1: Create the GitHub App module**

```typescript
export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
}

function getClientId(): string {
  const id = process.env.GITHUB_APP_CLIENT_ID;
  if (!id) throw new Error("GITHUB_APP_CLIENT_ID is required");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!secret) throw new Error("GITHUB_APP_CLIENT_SECRET is required");
  return secret;
}

export function getGitHubAuthorizeUrl(
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: redirectUri,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as GitHubTokenResponse & { error?: string };
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error}`);
  }
  return data;
}

export async function refreshGitHubToken(
  refreshToken: string
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as GitHubTokenResponse & { error?: string };
  if (data.error) {
    throw new Error(`GitHub refresh error: ${data.error}`);
  }
  return data;
}

export async function getGitHubUser(
  accessToken: string
): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }

  return (await response.json()) as GitHubUser;
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/oauth/github-app.ts
git commit -m "feat: add GitHub App OAuth token exchange and refresh"
```

---

### Task 6: Create org membership verification

**Files:**
- Create: `src/oauth/membership.ts`

- [ ] **Step 1: Create the membership module**

```typescript
const ALLOWED_ORG = process.env.ALLOWED_ORG || "fastfive-dev";

/**
 * Verify that the authenticated user is a member of the allowed org.
 * Uses GET /user/memberships/orgs/{org} which works for private members too.
 */
export async function verifyOrgMembership(
  accessToken: string
): Promise<boolean> {
  const response = await fetch(
    `https://api.github.com/user/memberships/orgs/${ALLOWED_ORG}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (response.status === 200) {
    const data = (await response.json()) as { state: string };
    return data.state === "active";
  }

  return false;
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/oauth/membership.ts
git commit -m "feat: add org membership verification"
```

---

### Task 7: Create OAuth endpoint handler

**Files:**
- Create: `src/oauth/handler.ts`

- [ ] **Step 1: Create the OAuth handler**

This is the largest new file. It handles all four OAuth endpoints.

```typescript
import { generateAuthCode, generateState, issueMcpToken, verifyPkce } from "./tokens.js";
import {
  exchangeCodeForToken,
  getGitHubAuthorizeUrl,
  getGitHubUser,
} from "./github-app.js";
import { verifyOrgMembership } from "./membership.js";
import { saveUserToken, saveAuthCode, getAndDeleteAuthCode } from "../storage/dynamo.js";

interface LambdaRequest {
  method: string;
  path: string;
  queryStringParameters?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function getBaseUrl(): string {
  // Set by SAM template or manually
  return process.env.BASE_URL || "";
}

// In-memory store for state → code_challenge mapping (lives within single Lambda invocation)
// For multi-step OAuth, we store state in DynamoDB via a temporary "state#" record
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
function getTableName(): string {
  return process.env.TOKEN_TABLE || "mcp-github-tokens";
}

async function saveOAuthState(
  state: string,
  codeChallenge: string,
  redirectUri: string
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 10 * 60;
  await ddbClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: { pk: `state#${state}`, codeChallenge, redirectUri, ttl },
    })
  );
}

async function getAndDeleteOAuthState(
  state: string
): Promise<{ codeChallenge: string; redirectUri: string } | null> {
  const key = { pk: `state#${state}` };
  const result = await ddbClient.send(
    new GetCommand({ TableName: getTableName(), Key: key })
  );
  if (!result.Item) return null;
  await ddbClient.send(
    new DeleteCommand({ TableName: getTableName(), Key: key })
  );
  return {
    codeChallenge: result.Item.codeChallenge as string,
    redirectUri: result.Item.redirectUri as string,
  };
}

/**
 * GET /.well-known/oauth-authorization-server
 */
function handleMetadata(): LambdaResponse {
  const baseUrl = getBaseUrl();
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    }),
  };
}

/**
 * GET /authorize
 * Params: response_type, code_challenge, code_challenge_method, state, redirect_uri
 */
async function handleAuthorize(
  params: Record<string, string>
): Promise<LambdaResponse> {
  const { code_challenge, state, redirect_uri } = params;

  if (!code_challenge || !state || !redirect_uri) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "invalid_request",
        error_description: "code_challenge, state, and redirect_uri are required",
      }),
    };
  }

  // Save state → code_challenge mapping in DynamoDB
  await saveOAuthState(state, code_challenge, redirect_uri);

  // Redirect to GitHub
  const callbackUri = `${getBaseUrl()}/callback`;
  const githubUrl = getGitHubAuthorizeUrl(callbackUri, state);

  return {
    statusCode: 302,
    headers: { Location: githubUrl },
    body: "",
  };
}

/**
 * GET /callback
 * GitHub redirects here with code and state.
 */
async function handleCallback(
  params: Record<string, string>
): Promise<LambdaResponse> {
  const { code, state } = params;

  if (!code || !state) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing code or state" }),
    };
  }

  // 1. Retrieve and delete state record
  const stateRecord = await getAndDeleteOAuthState(state);
  if (!stateRecord) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid or expired state" }),
    };
  }

  // 2. Exchange GitHub code for token
  const tokenResponse = await exchangeCodeForToken(code);

  // 3. Get GitHub user info
  const user = await getGitHubUser(tokenResponse.access_token);

  // 4. Verify org membership
  const isMember = await verifyOrgMembership(tokenResponse.access_token);
  if (!isMember) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "text/html" },
      body: "<h1>Access Denied</h1><p>You are not a member of the allowed organization.</p>",
    };
  }

  // 5. Save GitHub token to DynamoDB
  const expiresAt = tokenResponse.expires_in
    ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
    : Math.floor(Date.now() / 1000) + 8 * 60 * 60; // default 8h

  await saveUserToken({
    githubUserId: String(user.id),
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || "",
    expiresAt,
  });

  // 6. Generate our own authorization code
  const authCode = generateAuthCode();
  await saveAuthCode({
    code: authCode,
    codeChallenge: stateRecord.codeChallenge,
    githubUserId: String(user.id),
    redirectUri: stateRecord.redirectUri,
  });

  // 7. Redirect back to claude.ai with our auth code
  const redirectUrl = new URL(stateRecord.redirectUri);
  redirectUrl.searchParams.set("code", authCode);
  redirectUrl.searchParams.set("state", state);

  return {
    statusCode: 302,
    headers: { Location: redirectUrl.toString() },
    body: "",
  };
}

/**
 * POST /token
 * Body: grant_type, code, code_verifier, redirect_uri
 */
async function handleToken(body: string): Promise<LambdaResponse> {
  let params: Record<string, string>;
  try {
    // Support both JSON and form-encoded
    if (body.startsWith("{")) {
      params = JSON.parse(body);
    } else {
      params = Object.fromEntries(new URLSearchParams(body));
    }
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "invalid_request" }),
    };
  }

  const { grant_type, code, code_verifier } = params;

  if (grant_type === "authorization_code") {
    if (!code || !code_verifier) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "invalid_request",
          error_description: "code and code_verifier are required",
        }),
      };
    }

    // 1. Retrieve and delete auth code (one-time use)
    const authCodeRecord = await getAndDeleteAuthCode(code);
    if (!authCodeRecord) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "invalid_grant" }),
      };
    }

    // 2. Verify PKCE
    if (!verifyPkce(code_verifier, authCodeRecord.codeChallenge)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }),
      };
    }

    // 3. Issue MCP JWT token
    const mcpToken = issueMcpToken(authCodeRecord.githubUserId, getBaseUrl());

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: mcpToken,
        token_type: "Bearer",
        expires_in: 86400, // 24h
      }),
    };
  }

  if (grant_type === "refresh_token") {
    // For MCP token refresh, we just issue a new JWT
    // The GitHub token refresh happens transparently in the MCP handler
    const { refresh_token: rt } = params;
    // We don't currently issue refresh tokens for MCP — clients re-auth
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "unsupported_grant_type",
        error_description: "refresh_token grant not yet supported",
      }),
    };
  }

  return {
    statusCode: 400,
    body: JSON.stringify({ error: "unsupported_grant_type" }),
  };
}

/**
 * Main OAuth router
 */
export async function handleOAuthRequest(
  req: LambdaRequest
): Promise<LambdaResponse> {
  const { method, path, queryStringParameters, body } = req;
  const params = queryStringParameters || {};

  if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
    return handleMetadata();
  }

  if (path === "/authorize" && method === "GET") {
    return handleAuthorize(params);
  }

  if (path === "/callback" && method === "GET") {
    return handleCallback(params);
  }

  if (path === "/token" && method === "POST") {
    return handleToken(body || "");
  }

  return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/oauth/handler.ts
git commit -m "feat: add OAuth 2.1 endpoint handler

Implements /.well-known/oauth-authorization-server, /authorize,
/callback, and /token endpoints with PKCE S256 and org membership
verification."
```

---

## Chunk 3: MCP Handler + Lambda Entry Point

### Task 8: Create MCP Streamable HTTP handler with auth

**Files:**
- Create: `src/mcp/handler.ts`

- [ ] **Step 1: Create the MCP handler**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { verifyMcpToken } from "../oauth/tokens.js";
import { getUserToken, saveUserToken } from "../storage/dynamo.js";
import { refreshGitHubToken } from "../oauth/github-app.js";
import { requestContext } from "../github-client.js";
import { registerOrgTools } from "../tools/org.js";
import { registerCommitTools } from "../tools/commits.js";
import { registerPRTools } from "../tools/pull-requests.js";
import { registerReviewTools } from "../tools/reviews.js";
import { registerLOCTools } from "../tools/loc.js";
import { registerContributionTools } from "../tools/contributions.js";

function createMcpServer(): McpServer {
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

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Ensure the user's GitHub token is still valid, refresh if needed.
 */
async function ensureValidGitHubToken(githubUserId: string): Promise<string> {
  const userToken = await getUserToken(githubUserId);
  if (!userToken) {
    throw new Error("No GitHub token found. Please re-authenticate.");
  }

  const now = Math.floor(Date.now() / 1000);
  // Refresh if expiring within 5 minutes
  if (userToken.expiresAt > now + 300) {
    return userToken.accessToken;
  }

  // Refresh the token
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

interface McpLambdaRequest {
  headers: Record<string, string>;
  body: string;
}

interface McpLambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Handle MCP request with authentication and per-user token context.
 */
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

        // Create mock IncomingMessage and ServerResponse to use transport.handleRequest
        // For Lambda, we need to adapt the request/response format
        const bodyObj = JSON.parse(req.body);

        // Use a simple approach: create a writable that captures the response
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
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/mcp/handler.ts
git commit -m "feat: add MCP Streamable HTTP handler with JWT auth and token refresh"
```

---

### Task 9: Create Lambda entry point

**Files:**
- Create: `src/lambda.ts`

- [ ] **Step 1: Create the Lambda handler**

```typescript
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
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/lambda.ts
git commit -m "feat: add Lambda entry point with route dispatch"
```

---

## Chunk 4: Infrastructure + Deployment

### Task 10: Create SAM template

**Files:**
- Create: `infra/template.yaml`

- [ ] **Step 1: Create the SAM template**

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Description: GitHub Org Monitor MCP Server

Parameters:
  GitHubAppClientId:
    Type: String
    Description: GitHub App Client ID
  GitHubAppClientSecret:
    Type: String
    Description: GitHub App Client Secret
    NoEcho: true
  JwtSecret:
    Type: String
    Description: JWT signing secret (min 32 chars)
    NoEcho: true
  AllowedOrg:
    Type: String
    Default: fastfive-dev
    Description: GitHub organization to restrict access to

Globals:
  Function:
    Runtime: nodejs20.x
    MemorySize: 256
    Timeout: 60

Resources:
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: prod
      CorsConfiguration:
        AllowOrigins:
          - "*"
        AllowMethods:
          - GET
          - POST
          - OPTIONS
        AllowHeaders:
          - Content-Type
          - Authorization
          - mcp-session-id

  McpFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: build/lambda.handler
      CodeUri: ../
      Environment:
        Variables:
          GITHUB_APP_CLIENT_ID: !Ref GitHubAppClientId
          GITHUB_APP_CLIENT_SECRET: !Ref GitHubAppClientSecret
          JWT_SECRET: !Ref JwtSecret
          ALLOWED_ORG: !Ref AllowedOrg
          TOKEN_TABLE: !Ref TokenTable
          BASE_URL: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/prod"
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref TokenTable
      Events:
        Metadata:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /.well-known/oauth-authorization-server
            Method: GET
        Authorize:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /authorize
            Method: GET
        Callback:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /callback
            Method: GET
        Token:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /token
            Method: POST
        Mcp:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /mcp
            Method: POST
        Health:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /health
            Method: GET
        Options:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /{proxy+}
            Method: OPTIONS

  TokenTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: mcp-github-tokens
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
      TimeToLiveSpecification:
        AttributeName: ttl
        Enabled: true

Outputs:
  ApiUrl:
    Description: API Gateway URL
    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/prod"
  McpEndpoint:
    Description: MCP Server endpoint for claude.ai connector
    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/prod/mcp"
```

- [ ] **Step 2: Verify build still works**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add infra/template.yaml
git commit -m "feat: add SAM template for Lambda, API Gateway, DynamoDB"
```

---

### Task 11: Update .gitignore and build script

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Add SAM artifacts to .gitignore**

Append to `.gitignore`:

```
# SAM
.aws-sam/
samconfig.toml
```

- [ ] **Step 2: Add deploy script to package.json**

Add to `scripts` in `package.json`:

```json
"deploy": "npm run build && cd infra && sam build && sam deploy",
"deploy:guided": "npm run build && cd infra && sam build && sam deploy --guided"
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore package.json
git commit -m "chore: add SAM artifacts to gitignore, add deploy scripts"
```

---

## Chunk 5: Integration Verification

### Task 12: Local build and smoke test

- [ ] **Step 1: Full clean build**

```bash
cd "/Users/juhyunkim/github mcp"
rm -rf build
npm run build
```

Expected: Build succeeds with all new files compiled including `build/lambda.js`, `build/oauth/*.js`, `build/storage/*.js`, `build/mcp/*.js`.

- [ ] **Step 2: Verify stdio mode still works (backward compatibility)**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | GITHUB_TOKEN=test node build/index.js 2>/dev/null | head -1
```

Expected: JSON response with `"result":{"protocolVersion":...,"capabilities":...,"serverInfo":...}`.

- [ ] **Step 3: Verify Lambda handler exports correctly**

```bash
node -e "import('./build/lambda.js').then(m => console.log(typeof m.handler))"
```

Expected: `function`

- [ ] **Step 4: Verify SAM template is valid**

```bash
cd infra && sam validate
```

Expected: Template is valid.

---

### Task 13: Deploy to AWS

**Prerequisites:**
- AWS CLI configured with credentials (`aws sts get-caller-identity` returns valid response)
- GitHub App created at `github.com/organizations/fastfive-dev/settings/apps`
  - Callback URL: will be set after first deploy
  - "Expire user authorization tokens" enabled
  - Permissions: Repository contents (read), Organization members (read)
  - Installed on fastfive-dev organization

- [ ] **Step 1: First deploy (guided)**

```bash
cd "/Users/juhyunkim/github mcp"
npm run deploy:guided
```

SAM will prompt for:
- Stack name: `github-org-monitor-mcp`
- Region: `ap-northeast-2` (or preferred)
- GitHubAppClientId: (from GitHub App settings)
- GitHubAppClientSecret: (from GitHub App settings)
- JwtSecret: (generate with `openssl rand -hex 32`)
- AllowedOrg: `fastfive-dev`

- [ ] **Step 2: Note the API URL from outputs**

```bash
aws cloudformation describe-stacks \
  --stack-name github-org-monitor-mcp \
  --query 'Stacks[0].Outputs' \
  --output table
```

- [ ] **Step 3: Update GitHub App callback URL**

Go to GitHub App settings and set Callback URL to:
`https://{api-gateway-url}/callback`

- [ ] **Step 4: Verify health endpoint**

```bash
curl https://{api-gateway-url}/health
```

Expected: `{"status":"ok","server":"github-org-monitor"}`

- [ ] **Step 5: Verify OAuth metadata endpoint**

```bash
curl https://{api-gateway-url}/.well-known/oauth-authorization-server
```

Expected: JSON with `authorization_endpoint`, `token_endpoint`, etc.

- [ ] **Step 6: Commit samconfig.toml if not gitignored**

The `samconfig.toml` is gitignored (contains region/stack info only, no secrets), so no commit needed.

---

### Task 14: Register as claude.ai custom connector

- [ ] **Step 1: Go to claude.ai/settings/connectors**

- [ ] **Step 2: Click "Add Custom Connector"**

- [ ] **Step 3: Enter the MCP server URL**

Use the `McpEndpoint` output from Task 13 step 2:
`https://{api-gateway-url}/mcp`

- [ ] **Step 4: Complete OAuth flow**

Click "Connect" → GitHub login → Authorize the App → Verify redirect back to claude.ai.

- [ ] **Step 5: Test a tool call**

In claude.ai, ask: "list_org_members for fastfive-dev"

Expected: Returns list of organization members.

---

### Task 15: Final commit and tag

- [ ] **Step 1: Create final commit if any changes remain**

```bash
cd "/Users/juhyunkim/github mcp"
git status
# If any unstaged changes:
git add -A
git commit -m "chore: finalize AWS Lambda + OAuth MCP deployment"
```

- [ ] **Step 2: Tag the release**

```bash
git tag -a v1.1.0 -m "feat: AWS Lambda deployment with GitHub App OAuth 2.1

- OAuth 2.1 with PKCE for claude.ai remote MCP
- GitHub App authentication per user
- Organization membership access control
- DynamoDB token storage with auto-refresh
- SAM infrastructure as code"
```
