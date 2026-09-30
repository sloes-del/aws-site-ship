import { confirm, input, password, select } from "@inquirer/prompts";
import {
  ensureAwsCli,
  listLocalProfiles,
  resolveIdentity,
  writeAccessKeys,
} from "../aws/credentials.js";
import { runAws, ssoLogin } from "../aws/cli.js";
import { loadConfig, saveConfig } from "../config.js";
import { fail, log, printJson } from "../ui.js";

export async function authCommand(opts: {
  profile?: string;
  region?: string;
  json?: boolean;
  yes?: boolean;
  /** Headless: pass key material (or use AWS_ACCESS_KEY_ID env) */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}): Promise<void> {
  const version = await ensureAwsCli();
  log.ok(`AWS CLI: ${version.split("\n")[0]}`);

  const cfg = loadConfig();
  const profiles = listLocalProfiles();
  const savedProfile =
    cfg.profile && profiles.includes(cfg.profile) ? cfg.profile : undefined;
  let profile =
    opts.profile ||
    process.env.AWS_PROFILE ||
    savedProfile ||
    (profiles.includes("default") ? "default" : profiles[0]) ||
    "aws-site-ship";
  let region =
    opts.region ||
    process.env.AWS_REGION ||
    cfg.region ||
    "us-east-1";

  const accessKeyId =
    opts.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    opts.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken =
    opts.sessionToken || process.env.AWS_SESSION_TOKEN;

  // 100% headless path: flags/env only, zero prompts
  if (opts.yes || (accessKeyId && secretAccessKey)) {
    if (accessKeyId && secretAccessKey) {
      await writeAccessKeys({
        profile,
        accessKeyId,
        secretAccessKey,
        region,
      });
      if (sessionToken) {
        await runAws(
          [
            "configure",
            "set",
            "aws_session_token",
            sessionToken,
            "--profile",
            profile,
          ],
          { throwOnFail: true },
        );
      }
      log.ok(`Headless keys -> profile "${profile}"`);
    } else if (!profiles.includes(profile) && profile !== "default" && !process.env.AWS_ACCESS_KEY_ID) {
      fail(
        `Headless auth needs credentials.\n` +
          `  Pass --access-key-id / --secret-access-key, or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY,\n` +
          `  or use --create-account on an Organizations management profile.\n` +
          `  Profile "${profile}" was not found locally.`,
        2,
      );
    }

    const identity = await resolveIdentity({
      profile,
      region,
      trySso: true,
      quiet: true,
    });
    saveConfig({ profile: identity.profile, region: identity.region });
    if (opts.json) {
      printJson({ ok: true, identity, headless: true });
      return;
    }
    log.title("Authenticated (headless)");
    log.ok(`Account  ${identity.account}`);
    log.ok(`ARN      ${identity.arn}`);
    log.ok(`Profile  ${identity.profile}`);
    log.ok(`Region   ${identity.region}`);
    return;
  }

  if (!opts.yes && !opts.profile) {
    const mode = await select({
      message: "How do you want to authenticate?",
      choices: [
        { name: "Use existing AWS CLI profile", value: "profile" },
        { name: "Paste access key + secret (IAM user)", value: "keys" },
        { name: "Run aws sso login on a profile", value: "sso" },
        {
          name: "Just verify current env/profile and exit",
          value: "verify",
        },
      ],
    });

    if (mode === "profile" || mode === "sso" || mode === "verify") {
      if (profiles.length) {
        profile = await select({
          message: "Choose profile",
          choices: [
            ...profiles.map((p) => ({ name: p, value: p })),
            { name: "Other (type name)", value: "__other__" },
          ],
          default: profile,
        });
        if (profile === "__other__") {
          profile = await input({
            message: "Profile name",
            default: "aws-site-ship",
          });
        }
      } else {
        profile = await input({
          message: "Profile name (none found yet)",
          default: "aws-site-ship",
        });
      }
    }

    region = await input({ message: "Region", default: region });

    if (mode === "keys") {
      profile = await input({
        message: "Save keys under profile name",
        default: profile || "aws-site-ship",
      });
      const accessKeyId = await input({ message: "AWS access key ID" });
      const secretAccessKey = await password({
        message: "AWS secret access key",
        mask: "*",
      });
      if (!accessKeyId || !secretAccessKey) {
        fail("Access key and secret are required", 2);
      }
      await writeAccessKeys({
        profile,
        accessKeyId,
        secretAccessKey,
        region,
      });
      log.ok(`Wrote credentials to profile "${profile}"`);
    }

    if (mode === "sso") {
      log.info(`Running: aws sso login --profile ${profile}`);
      const r = await ssoLogin(profile);
      if (r.code !== 0) {
        fail(
          `SSO login failed. Configure SSO first:\n  aws configure sso --profile ${profile}\n${r.stderr || r.stdout}`,
          2,
        );
      }
      log.ok("SSO login finished");
    }
  }

  // Non-interactive path: still try resolve
  try {
    const identity = await resolveIdentity({
      profile,
      region,
      trySso: true,
    });
    saveConfig({ profile: identity.profile, region: identity.region });

    if (opts.json) {
      printJson({ ok: true, identity });
      return;
    }

    log.title("Authenticated");
    log.ok(`Account  ${identity.account}`);
    log.ok(`ARN      ${identity.arn}`);
    log.ok(`Profile  ${identity.profile}`);
    log.ok(`Region   ${identity.region}`);
    log.dim(`Config saved → tool will reuse this profile on deploy`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!opts.yes) {
      const tryConfigure = await confirm({
        message:
          "Identity still failing. Run interactive `aws configure` for this profile?",
        default: true,
      });
      if (tryConfigure) {
        log.info(`Starting: aws configure --profile ${profile}`);
        // interactive inherit stdio
        const r = await runAws(["configure", "--profile", profile], {
          throwOnFail: false,
        });
        // `aws configure` is interactive; spawn without shell capture is better —
        // user may need to run it themselves if this doesn't attach TTY well.
        if (r.code !== 0) {
          log.warn(
            `Could not drive interactive configure cleanly. Run manually:\n  aws configure --profile ${profile}`,
          );
        }
        const identity = await resolveIdentity({
          profile,
          region,
          trySso: false,
        });
        saveConfig({ profile: identity.profile, region: identity.region });
        log.ok(`Account ${identity.account} · ${identity.arn}`);
        return;
      }
    }
    fail(msg, 2);
  }
}
