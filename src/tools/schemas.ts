import { z } from "zod/v4";

/** GitHub username or org name: alphanumeric + hyphens only */
export const githubSlug = z
  .string()
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/, "Invalid GitHub identifier");

/** ISO 8601 date string (YYYY-MM-DD or full ISO) */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/, "Invalid ISO 8601 date");
