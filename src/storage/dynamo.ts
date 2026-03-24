import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { encryptToken, decryptToken } from "../utils/crypto.js";

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
        accessToken: encryptToken(token.accessToken),
        refreshToken: encryptToken(token.refreshToken),
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
    accessToken: decryptToken(result.Item.accessToken as string),
    refreshToken: decryptToken(result.Item.refreshToken as string),
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
  // Atomic delete-and-return to prevent race conditions
  try {
    const result = await docClient.send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: key,
        ReturnValues: "ALL_OLD",
        ConditionExpression: "attribute_exists(pk)",
      })
    );
    if (!result.Attributes) return null;
    return {
      code,
      codeChallenge: result.Attributes.codeChallenge as string,
      githubUserId: result.Attributes.githubUserId as string,
      redirectUri: result.Attributes.redirectUri as string,
    };
  } catch (err: unknown) {
    // ConditionalCheckFailedException means item was already deleted
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      return null;
    }
    throw err;
  }
}

// --- OAuth state (pk: "state#{state}") ---

export interface OAuthState {
  codeChallenge: string;
  redirectUri: string;
}

export async function saveOAuthState(
  state: string,
  codeChallenge: string,
  redirectUri: string
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
  await docClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: { pk: `state#${state}`, codeChallenge, redirectUri, ttl },
    })
  );
}

export async function getAndDeleteOAuthState(
  state: string
): Promise<OAuthState | null> {
  const key = { pk: `state#${state}` };
  // Atomic delete-and-return to prevent race conditions
  try {
    const result = await docClient.send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: key,
        ReturnValues: "ALL_OLD",
        ConditionExpression: "attribute_exists(pk)",
      })
    );
    if (!result.Attributes) return null;
    return {
      codeChallenge: result.Attributes.codeChallenge as string,
      redirectUri: result.Attributes.redirectUri as string,
    };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      return null;
    }
    throw err;
  }
}
