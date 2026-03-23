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
