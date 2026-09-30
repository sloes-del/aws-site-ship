import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  awsVersion,
  getCallerIdentity,
  runAws,
  ssoLogin,
} from "./cli.js";
import { loadConfig, saveConfig } from "../config.js";
import { fail, log } from "../ui.js";

export type Identity = {
  account: string;
  arn: string;
  userId: string;
  profile: string;
  region: string;
};

function parseIniProfiles(content: string): string[] {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(?:profile\s+)?([^\]]+)\]\s*$/);
    if (m?.[1] && m[1] !== "default") names.add(m[1]);
    if (line.match(/^\s*\[default\]\s*$/)) names.add("default");
  }
  return [...names];
}

export function listLocalProfiles(): string[] {
  const creds = join(homedir(), ".aws", "credentials");
  const cfg = join(homedir(), ".aws", "config");
  const found = new Set<string>();
  if (existsSync(creds)) {
    for (const p of parseIniProfiles(readFileSync(creds, "utf8"))) found.add(p);
  }
  if (existsSync(cfg)) {
    for (const p of parseIniProfiles(readFileSync(cfg, "utf8"))) found.add(p);
  }
  return [...found].sort();
}

export async function ensureAwsCli(): Promise<string> {
  const v = await awsVersion();
  if (!v) {
    fail(
      "AWS CLI not found in PATH. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
      2,
    );
  }
  return v;
}

/**
 * Resolve working identity: try profile, optionally SSO login once, persist config.
 */
function pickDefaultProfile(cfgProfile: string): string {
  if (process.env.AWS_PROFILE) return process.env.AWS_PROFILE;
  const local = listLocalProfiles();
  // Prefer saved config only if that profile actually exists
  if (cfgProfile && local.includes(cfgProfile)) return cfgProfile;
  if (local.includes("default")) return "default";
  if (local.length > 0) return local[0]!;
  // Fall back to env credentials (no profile flag)
  if (process.env.AWS_ACCESS_KEY_ID) return "default";
  // No profiles on disk — omit custom names that don't exist yet
  return "default";
}

export async function resolveIdentity(opts: {
  profile?: string;
  region?: string;
  trySso?: boolean;
  quiet?: boolean;
}): Promise<Identity> {
  await ensureAwsCli();
  const cfg = loadConfig();
  const profile = opts.profile || pickDefaultProfile(cfg.profile);
  const region =
    opts.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    cfg.region ||
    "us-east-1";

  const attempt = async (p: string) => {
    const id = await getCallerIdentity(
      p === "default" ? undefined : p,
      region,
    );
    return {
      account: id.Account,
      arn: id.Arn,
      userId: id.UserId,
      profile: p,
      region,
    } satisfies Identity;
  };

  try {
    const identity = await attempt(profile);
    saveConfig({ profile: identity.profile, region: identity.region });
    return identity;
  } catch (first) {
    // Env keys without a named profile
    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        const identity = await attempt("default");
        saveConfig({ profile: identity.profile, region: identity.region });
        return identity;
      } catch {
        /* continue */
      }
    }

    const localProfiles = listLocalProfiles();
    if (
      opts.trySso !== false &&
      profile !== "default" &&
      localProfiles.includes(profile)
    ) {
      if (!opts.quiet) {
        log.warn(
          `Credentials failed for profile "${profile}". Trying aws sso login…`,
        );
      }
      const login = await ssoLogin(profile);
      if (login.code === 0) {
        try {
          const identity = await attempt(profile);
          saveConfig({ profile: identity.profile, region: identity.region });
          return identity;
        } catch {
          /* fall through */
        }
      }
    }
    const msg = first instanceof Error ? first.message : String(first);
    fail(
      `Could not resolve AWS identity for profile "${profile}".\n  ${msg}\n  Run: aws-site-ship auth`,
      2,
    );
  }
}

export async function writeAccessKeys(opts: {
  profile: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}): Promise<void> {
  await runAws(
    ["configure", "set", "aws_access_key_id", opts.accessKeyId, "--profile", opts.profile],
    { throwOnFail: true },
  );
  await runAws(
    ["configure", "set", "aws_secret_access_key", opts.secretAccessKey, "--profile", opts.profile],
    { throwOnFail: true },
  );
  await runAws(
    ["configure", "set", "region", opts.region, "--profile", opts.profile],
    { throwOnFail: true },
  );
  await runAws(
    ["configure", "set", "output", "json", "--profile", opts.profile],
    { throwOnFail: true },
  );
}
