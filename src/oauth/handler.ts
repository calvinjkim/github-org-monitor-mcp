import { generateAuthCode, issueMcpToken, verifyPkce } from "./tokens.js";
import {
  exchangeCodeForToken,
  getGitHubAuthorizeUrl,
  getGitHubUser,
} from "./github-app.js";
import { verifyOrgMembership } from "./membership.js";
import {
  saveUserToken,
  saveAuthCode,
  getAndDeleteAuthCode,
  saveOAuthState,
  getAndDeleteOAuthState,
} from "../storage/dynamo.js";

export interface LambdaRequest {
  method: string;
  path: string;
  queryStringParameters?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

export interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function getBaseUrl(): string {
  return process.env.BASE_URL || "";
}

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

async function handleAuthorize(
  params: Record<string, string>
): Promise<LambdaResponse> {
  const { code_challenge, state, redirect_uri } = params;

  if (!code_challenge || !state || !redirect_uri) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "invalid_request",
        error_description: "code_challenge, state, and redirect_uri are required",
      }),
    };
  }

  await saveOAuthState(state, code_challenge, redirect_uri);

  const callbackUri = `${getBaseUrl()}/callback`;
  const githubUrl = getGitHubAuthorizeUrl(callbackUri, state);

  return {
    statusCode: 302,
    headers: { Location: githubUrl },
    body: "",
  };
}

async function handleCallback(
  params: Record<string, string>
): Promise<LambdaResponse> {
  const { code, state } = params;

  if (!code || !state) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing code or state" }),
    };
  }

  const stateRecord = await getAndDeleteOAuthState(state);
  if (!stateRecord) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid or expired state" }),
    };
  }

  const tokenResponse = await exchangeCodeForToken(code);
  const user = await getGitHubUser(tokenResponse.access_token);

  const isMember = await verifyOrgMembership(tokenResponse.access_token);
  if (!isMember) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "text/html" },
      body: "<h1>Access Denied</h1><p>You are not a member of the allowed organization.</p>",
    };
  }

  const expiresAt = tokenResponse.expires_in
    ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
    : Math.floor(Date.now() / 1000) + 8 * 60 * 60;

  await saveUserToken({
    githubUserId: String(user.id),
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || "",
    expiresAt,
  });

  const authCode = generateAuthCode();
  await saveAuthCode({
    code: authCode,
    codeChallenge: stateRecord.codeChallenge,
    githubUserId: String(user.id),
    redirectUri: stateRecord.redirectUri,
  });

  const redirectUrl = new URL(stateRecord.redirectUri);
  redirectUrl.searchParams.set("code", authCode);
  redirectUrl.searchParams.set("state", state);

  return {
    statusCode: 302,
    headers: { Location: redirectUrl.toString() },
    body: "",
  };
}

async function handleToken(body: string): Promise<LambdaResponse> {
  let params: Record<string, string>;
  try {
    if (body.startsWith("{")) {
      params = JSON.parse(body);
    } else {
      params = Object.fromEntries(new URLSearchParams(body));
    }
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "invalid_request" }),
    };
  }

  const { grant_type, code, code_verifier, redirect_uri } = params;

  if (grant_type === "authorization_code") {
    if (!code || !code_verifier) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "invalid_request",
          error_description: "code and code_verifier are required",
        }),
      };
    }

    const authCodeRecord = await getAndDeleteAuthCode(code);
    if (!authCodeRecord) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "invalid_grant" }),
      };
    }

    // Verify redirect_uri matches the one from the authorization request (required per RFC 6749 4.1.3)
    if (!redirect_uri || redirect_uri !== authCodeRecord.redirectUri) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: "redirect_uri mismatch",
        }),
      };
    }

    if (!verifyPkce(code_verifier, authCodeRecord.codeChallenge)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }),
      };
    }

    const mcpToken = issueMcpToken(authCodeRecord.githubUserId, getBaseUrl());

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: mcpToken,
        token_type: "Bearer",
        expires_in: 86400,
      }),
    };
  }

  return {
    statusCode: 400,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "unsupported_grant_type" }),
  };
}

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

  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Not found" }),
  };
}
