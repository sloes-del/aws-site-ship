import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createAccountCommand } from "./create-account.js";
import { initCommand } from "./init.js";
import { deployCommand } from "./deploy.js";
import {
  listLocalProfiles,
  resolveIdentity,
  writeAccessKeys,
} from "../aws/credentials.js";
import { mergeAuth, requireValue } from "../headless.js";
import { loadConfig, saveConfig } from "../config.js";
import { fail, log, printJson } from "../ui.js";

/**
 * One-shot fully non-interactive pipeline:
 *   [optional org create] → auth material → init bucket/public → deploy
 *
 * Brand-new *root* AWS accounts still need a human once (phone/card).
 * With a management account, member creation + deploy is 100% headless API.
 */
export async function headlessCommand(opts: {
  dir?: string;
  profile?: string;
  region?: string;
  bucket?: string;
  words?: string[];
  prefix?: string;
  public?: boolean;
  website?: boolean;
  /** Create member account first */
  createAccount?: boolean;
  email?: string;
  name?: string;
  managementProfile?: string;
  memberProfile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  json?: boolean;
}): Promise<void> {
  const auth = mergeAuth({
    profile: opts.profile,
    region: opts.region,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    sessionToken: opts.sessionToken,
  });

  const region = auth.region || "us-east-1";
  const dir = resolve(opts.dir || "./dist");
  const memberProfile =
    opts.memberProfile ||
    process.env.AWS_SITE_SHIP_MEMBER_PROFILE ||
    "aws-site-ship";

  log.title("aws-site-ship headless");

  const wantCreate =
    Boolean(opts.createAccount) ||
    process.env.AWS_SITE_SHIP_CREATE_ACCOUNT === "1";

  // 1) Optional Organizations CreateAccount
  if (wantCreate) {
    await createAccountCommand({
      email: opts.email,
      name: opts.name,
      managementProfile: opts.managementProfile || auth.profile,
      memberProfile,
      region,
      yes: true,
      json: false,
      admin: true,
    });
    auth.profile = memberProfile;
  } else if (auth.accessKeyId && auth.secretAccessKey) {
    // 2) Inject keys into profile with zero prompts
    const profile = auth.profile || memberProfile;
    await writeAccessKeys({
      profile,
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
      region,
    });
    if (auth.sessionToken) {
      const { runAws } = await import("../aws/cli.js");
      await runAws(
        [
          "configure",
          "set",
          "aws_session_token",
          auth.sessionToken,
          "--profile",
          profile,
        ],
        { throwOnFail: true },
      );
    }
    auth.profile = profile;
    log.ok(`Wrote keys -> profile "${profile}"`);
  } else {
    const cfg = loadConfig();
    const local = listLocalProfiles();
    const candidate =
      auth.profile ||
      process.env.AWS_PROFILE ||
      (cfg.profile && local.includes(cfg.profile) ? cfg.profile : undefined) ||
      (local.includes("default") ? "default" : local[0]);
    if (!candidate) {
      fail(
        "Headless mode needs one of:\n" +
          "  --access-key-id + --secret-access-key  (or AWS_ACCESS_KEY_ID/SECRET)\n" +
          "  --profile <existing>                   (or AWS_PROFILE)\n" +
          "  --create-account --email you@domain    (Organizations management creds)\n",
        2,
      );
    }
    auth.profile = candidate;
  }

  const profile = requireValue(
    "--profile / AWS_PROFILE / member profile after create",
    auth.profile || memberProfile,
  );

  // Verify identity headlessly
  const identity = await resolveIdentity({
    profile,
    region,
    trySso: true,
    quiet: true,
  });
  log.ok(`Identity ${identity.account} · ${identity.arn}`);

  // 3) Init bucket (public by default in headless ship path — URL must work)
  const wantPublic =
    opts.public !== false && process.env.AWS_SITE_SHIP_PRIVATE !== "1";
  const wantWebsite =
    opts.website === true || process.env.AWS_SITE_SHIP_WEBSITE === "1";

  await initCommand({
    profile,
    region,
    bucket: opts.bucket,
    public: wantPublic,
    website: wantWebsite,
    yes: true,
    json: false,
  });

  // 4) Deploy
  if (!existsSync(dir)) {
    fail(
      `Deploy dir missing: ${dir}. Pass --dir or create the folder.`,
      4,
    );
  }

  await deployCommand(dir, {
    profile,
    region,
    bucket: opts.bucket || loadConfig().bucket,
    words: opts.words,
    prefix: opts.prefix,
    yes: true,
    json: false,
  });

  const cfg = loadConfig();
  saveConfig({ profile, region });

  const summary = {
    ok: true,
    account: identity.account,
    profile,
    region,
    bucket: cfg.bucket,
    lastDeploy: cfg.lastDeploy,
  };

  if (opts.json) {
    printJson(summary);
    return;
  }

  log.title("Headless pipeline complete");
  if (cfg.lastDeploy?.url) {
    log.ok(cfg.lastDeploy.url);
  }
}
