/**
 * Shared headless option parsing: flags win, then env, then config.
 * No prompts. Missing required values → throw (caller maps to exit code).
 */

export type HeadlessAuthInput = {
  profile?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export function envAuth(): HeadlessAuthInput {
  return {
    profile: process.env.AWS_PROFILE,
    region:
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      process.env.AWS_SITE_SHIP_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

export function mergeAuth(
  flags: HeadlessAuthInput,
  env = envAuth(),
): HeadlessAuthInput {
  return {
    profile: flags.profile || env.profile,
    region: flags.region || env.region || "us-east-1",
    accessKeyId: flags.accessKeyId || env.accessKeyId,
    secretAccessKey: flags.secretAccessKey || env.secretAccessKey,
    sessionToken: flags.sessionToken || env.sessionToken,
  };
}

export function requireValue(
  name: string,
  value: string | undefined,
): string {
  if (!value) {
    throw new Error(
      `Missing required ${name}. Pass flag or set env (headless mode has no prompts).`,
    );
  }
  return value;
}

/** Unique-ish account email local-part helper for org create. */
export function stampEmail(baseEmail: string): string {
  const at = baseEmail.indexOf("@");
  if (at < 1) return baseEmail;
  const local = baseEmail.slice(0, at);
  const domain = baseEmail.slice(at + 1);
  const stamp = Date.now().toString(36);
  // plus-addressing works on most mail providers
  if (local.includes("+")) {
    return `${local}-${stamp}@${domain}`;
  }
  return `${local}+ship-${stamp}@${domain}`;
}
