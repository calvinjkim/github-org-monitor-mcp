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
