#!/usr/bin/env node
import { Command } from "commander";
import { authCommand } from "./commands/auth.js";
import { createAccountCommand } from "./commands/create-account.js";
import { deployCommand } from "./commands/deploy.js";
import { headlessCommand } from "./commands/headless.js";
import { initCommand } from "./commands/init.js";
import { openLastCommand } from "./commands/open-last.js";
import { signupCommand } from "./commands/signup.js";
import { whoamiCommand } from "./commands/whoami.js";
import { fail } from "./ui.js";

const program = new Command();

program
  .name("aws-site-ship")
  .description(
    "Headless-friendly AWS auth + deploy static sites to s3.amazonaws.com/<bucket>/<word1>-<word2>/index.html",
  )
  .version("0.2.0");

program
  .command("whoami")
  .description("Show resolved AWS identity for the configured profile")
  .option("--profile <name>", "AWS profile")
  .option("--region <region>", "AWS region")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    await whoamiCommand(opts);
  });

program
  .command("auth")
  .description(
    "Configure AWS CLI credentials (interactive or headless via flags/env)",
  )
  .option("--profile <name>", "AWS profile")
  .option("--region <region>", "AWS region")
  .option("--access-key-id <id>", "Headless: access key id")
  .option("--secret-access-key <secret>", "Headless: secret access key")
  .option("--session-token <token>", "Headless: session token")
  .option("-y, --yes", "Non-interactive / headless")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    await authCommand({
      profile: opts.profile,
      region: opts.region,
      yes: opts.yes,
      json: opts.json,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      sessionToken: opts.sessionToken,
    });
  });

program
  .command("signup")
  .description(
    "Guided root signup checklist (browser). Prefer create-account for headless members.",
  )
  .option("--no-open", "Print checklist only")
  .action(async (opts) => {
    await signupCommand({ noOpen: opts.open === false });
  });

program
  .command("create-account")
  .description(
    "HEADLESS: Organizations CreateAccount + assume role + IAM deploy user/keys",
  )
  .option("--email <email>", "Unique root email for the new member account")
  .option("--name <name>", "Account name")
  .option("--profile <name>", "Management account AWS profile")
  .option("--management-profile <name>", "Alias for --profile (management)")
  .option(
    "--member-profile <name>",
    "Local CLI profile to write member keys into",
    "aws-site-ship",
  )
  .option(
    "--role-name <name>",
    "OrganizationAccountAccessRole name",
    "OrganizationAccountAccessRole",
  )
  .option("--region <region>", "Region for STS/IAM follow-up", "us-east-1")
  .option("--skip-iam", "Only create account; do not provision IAM user")
  .option("--no-admin", "Use tight S3 inline policy instead of AdministratorAccess")
  .option("--no-stamp", "Do not plus-address stamp the email")
  .option("-y, --yes", "Headless (always on for this command)")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    await createAccountCommand({
      email: opts.email,
      name: opts.name,
      profile: opts.profile,
      managementProfile: opts.managementProfile,
      memberProfile: opts.memberProfile,
      roleName: opts.roleName,
      region: opts.region,
      skipIam: opts.skipIam,
      admin: opts.admin,
      stamp: opts.stamp,
      yes: true,
      json: opts.json,
    });
  });

program
  .command("init")
  .description("Ensure S3 bucket + optional public read / website hosting")
  .option("--profile <name>", "AWS profile")
  .option("--region <region>", "AWS region")
  .option("--bucket <name>", "S3 bucket name")
  .option("--public", "Enable public GetObject policy")
  .option("--website", "Enable S3 static website hosting")
  .option("-y, --yes", "Accept defaults / flags without prompts")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    await initCommand(opts);
  });

program
  .command("deploy")
  .description("Upload a static directory to a word-pair prefix on S3")
  .argument("[dir]", "Local directory to deploy", "./dist")
  .option("--profile <name>", "AWS profile")
  .option("--region <region>", "AWS region")
  .option("--bucket <name>", "S3 bucket name")
  .option(
    "--words <words...>",
    "Two words for the path prefix (e.g. --words forest lamp)",
  )
  .option("--prefix <path>", "Explicit key prefix (overrides --words)")
  .option("--joiner <char>", "Word joiner", "-")
  .option("--unique", "Append short random suffix to prefix")
  .option("-y, --yes", "Non-interactive")
  .option("--json", "Machine-readable output")
  .action(async (dir, opts) => {
    await deployCommand(dir, opts);
  });

program
  .command("headless")
  .description(
    "100% non-interactive: [create-account] -> auth -> init -> deploy",
  )
  .option("--dir <path>", "Static site directory", "./dist")
  .option("--profile <name>", "AWS profile (or management profile with --create-account)")
  .option("--region <region>", "AWS region", "us-east-1")
  .option("--bucket <name>", "S3 bucket name")
  .option("--words <words...>", "Path words")
  .option("--prefix <path>", "Explicit prefix")
  .option("--public", "Public read (default on unless AWS_SITE_SHIP_PRIVATE=1)")
  .option("--website", "Enable website endpoint")
  .option("--create-account", "Run Organizations CreateAccount first")
  .option("--email <email>", "Member account email (with --create-account)")
  .option("--name <name>", "Member account name")
  .option("--management-profile <name>", "Management profile for org create")
  .option("--member-profile <name>", "Profile for member keys", "aws-site-ship")
  .option("--access-key-id <id>", "Headless keys (skip create-account)")
  .option("--secret-access-key <secret>", "Headless secret")
  .option("--session-token <token>", "Optional session token")
  .option("--json", "Machine-readable final summary")
  .action(async (opts) => {
    await headlessCommand({
      dir: opts.dir,
      profile: opts.profile,
      region: opts.region,
      bucket: opts.bucket,
      words: opts.words,
      prefix: opts.prefix,
      public: opts.public,
      website: opts.website,
      createAccount: opts.createAccount,
      email: opts.email,
      name: opts.name,
      managementProfile: opts.managementProfile,
      memberProfile: opts.memberProfile,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      sessionToken: opts.sessionToken,
      json: opts.json,
    });
  });

program
  .command("open")
  .description("Open the last deployed path-style URL in your browser")
  .action(async () => {
    await openLastCommand();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg, 1);
});
