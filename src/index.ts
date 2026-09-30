#!/usr/bin/env node
import { Command } from "commander";
import { authCommand } from "./commands/auth.js";
import { autoSignupCommand } from "./commands/auto-signup.js";
import { createAccountCommand } from "./commands/create-account.js";
import { deployCommand } from "./commands/deploy.js";
import { headlessCommand } from "./commands/headless.js";
import { initCommand } from "./commands/init.js";
import { bypassCaptchaCommand } from "./commands/bypass-captcha.js";
import {
  mercuryAccountsCommand,
  mercuryAuthCommand,
  mercuryCancelCommand,
  mercuryCancelDueCommand,
  mercuryCardCommand,
  mercuryListCommand,
  mercuryOpenCommand,
  mercuryPolicyCommand,
  mercuryRevealCommand,
  mercuryUsersCommand,
} from "./commands/mercury.js";
import {
  onlinesimAuthCommand,
  onlinesimBalanceCommand,
  onlinesimFinishCommand,
  onlinesimNumberCommand,
  onlinesimRentCloseCommand,
  onlinesimRentStateCommand,
  onlinesimReviseCommand,
  onlinesimStateCommand,
  onlinesimTariffsCommand,
  onlinesimWaitCommand,
} from "./commands/onlinesim.js";
import { openLastCommand } from "./commands/open-last.js";
import { signupCommand } from "./commands/signup.js";
import { whoamiCommand } from "./commands/whoami.js";
import { loadEnv } from "./env.js";
import { fail } from "./ui.js";

loadEnv();

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
  .command("auto-signup")
  .description(
    "Assisted AWS root signup pack: disposable email + OnlineSim phone + $1 Mercury card + open browser (no CAPTCHA solver)",
  )
  .option("--email <email>", "Use this email instead of mail.tm disposable")
  .option("--account-name <name>", "AWS account name")
  .option("--service <name>", "onlinesim service slug", "amazon")
  .option("--tzid <id>", "Reuse existing onlinesim operation")
  .option("--number <e164>", "Reuse phone number label")
  .option("--wait-sms", "Block until SMS OTP arrives")
  .option("--wait-email", "Block until AWS-looking email arrives")
  .option("--timeout <sec>", "Wait timeout seconds", "180")
  .option("--skip-mercury", "Do not issue Mercury $1 card")
  .option("--skip-phone", "Do not order OnlineSim number")
  .option("--skip-email", "Do not create disposable inbox")
  .option("--open-temp-tf", "Also open https://temp.tf/ in browser")
  .option("--no-open", "Do not open AWS/Mercury browser tabs")
  .option("--json", "Machine-readable signup pack")
  .action(async (opts) => {
    await autoSignupCommand({
      email: opts.email,
      accountName: opts.accountName,
      service: opts.service,
      tzid: opts.tzid,
      number: opts.number,
      waitSms: opts.waitSms,
      waitEmail: opts.waitEmail,
      timeout: opts.timeout,
      skipMercury: opts.skipMercury,
      skipPhone: opts.skipPhone,
      skipEmail: opts.skipEmail,
      openTempTf: opts.openTempTf,
      noOpen: opts.open === false,
      json: opts.json,
    });
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

program
  .command("bypass-captcha")
  .description(
    "How to skip AWS root CAPTCHA: Organizations CreateAccount (supported path)",
  )
  .option("--json", "Machine-readable playbook")
  .action(async (opts) => {
    await bypassCaptchaCommand({ json: opts.json });
  });

// ── mercury.com (virtual debit cards) ─────────────────────────────
const mercury = program
  .command("mercury")
  .description(
    "Mercury API: virtual debit cards ($1 daily default, cancel next day). Browser for tokens/PAN — no automation.",
  )
  .option("--token <token>", "Mercury API token (or MERCURY_API_TOKEN)");

mercury
  .command("auth")
  .description("Open token settings in browser; optionally save --token")
  .option("--token <token>", "Mercury API token to verify + save")
  .option("--no-open", "Do not open browser")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryAuthCommand({
      token: opts.token || parent.token,
      noOpen: opts.open === false,
      json: opts.json,
    });
  });

mercury
  .command("policy")
  .description("Show default $1 / expire-next-day debit policy")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    await mercuryPolicyCommand({ json: opts.json });
  });

mercury
  .command("accounts")
  .description("List Mercury accounts")
  .option("--token <token>", "Mercury API token")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryAccountsCommand({
      token: opts.token || parent.token,
      json: opts.json,
    });
  });

mercury
  .command("users")
  .description("List org users (cardholders must exist in dashboard first)")
  .option("--token <token>", "Mercury API token")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryUsersCommand({
      token: opts.token || parent.token,
      json: opts.json,
    });
  });

mercury
  .command("card")
  .description(
    "Issue virtual debit card: default $1 daily spend, schedule cancel next local midnight",
  )
  .option("--token <token>", "Mercury API token")
  .option("--account <id>", "Funding account id")
  .option("--user <id>", "Cardholder user id")
  .option("--nickname <name>", "Card nickname")
  .option("--budget <usd>", "Spend limit in dollars", "1")
  .option("--interval <period>", "daily|weekly|monthly|yearly", "daily")
  .option(
    "--expire-hours <n>",
    "Cancel after N hours instead of next local midnight",
  )
  .option("--no-cancel-schedule", "Do not store cancelAt for cancel-due")
  .option("--no-open", "Do not open cards dashboard in browser")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryCardCommand({
      token: opts.token || parent.token,
      account: opts.account,
      user: opts.user,
      nickname: opts.nickname,
      budget: opts.budget,
      interval: opts.interval,
      expireHours: opts.expireHours,
      noCancelSchedule: opts.cancelSchedule === false,
      open: opts.open,
      json: opts.json,
    });
  });

mercury
  .command("list")
  .description("List cards")
  .option("--token <token>", "Mercury API token")
  .option("--account <id>", "Filter by account")
  .option("--kind <kind>", "debit|credit", "debit")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryListCommand({
      token: opts.token || parent.token,
      account: opts.account,
      kind: opts.kind,
      json: opts.json,
    });
  });

mercury
  .command("cancel")
  .description("Cancel a card now (permanent)")
  .option("--token <token>", "Mercury API token")
  .option("--id <cardId>", "Card id (default: last created)")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryCancelCommand({
      token: opts.token || parent.token,
      id: opts.id,
      json: opts.json,
    });
  });

mercury
  .command("cancel-due")
  .description("Cancel last card if cancelAt has passed (expire-next-day)")
  .option("--token <token>", "Mercury API token")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryCancelDueCommand({
      token: opts.token || parent.token,
      json: opts.json,
    });
  });

mercury
  .command("open")
  .description("Open Mercury dashboard pages in your real browser")
  .option("--cards", "Cards page (default)")
  .option("--tokens", "API token settings")
  .option("--account", "Accounts page")
  .action(async (opts) => {
    await mercuryOpenCommand({
      cards: opts.cards,
      tokens: opts.tokens,
      account: opts.account,
    });
  });

mercury
  .command("reveal")
  .description("Reveal PAN/CVC via Vault (agent cards only); else use browser")
  .option("--token <token>", "Mercury API token")
  .option("--id <cardId>", "Card id")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await mercuryRevealCommand({
      token: opts.token || parent.token,
      id: opts.id,
      json: opts.json,
    });
  });

// ── onlinesim.io (SMS / rent numbers) ─────────────────────────────
const onlinesim = program
  .command("onlinesim")
  .description(
    "onlinesim.io integration: balance, get number, wait for SMS, rent",
  )
  .option("--apikey <key>", "onlinesim API key (or ONLINESIM_API_KEY)")
  .option("--lang <code>", "Response language", "en");

onlinesim
  .command("auth")
  .description("Verify API key and save to ~/.aws-site-ship/config.json")
  .option("--apikey <key>", "onlinesim API key")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimAuthCommand({
      apikey: opts.apikey || parent.apikey,
      json: opts.json,
    });
  });

onlinesim
  .command("balance")
  .description("Show onlinesim profile balance")
  .option("--apikey <key>", "onlinesim API key")
  .option("--income", "Include referral income fields")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimBalanceCommand({
      apikey: opts.apikey || parent.apikey,
      income: opts.income,
      json: opts.json,
    });
  });

onlinesim
  .command("tariffs")
  .description("List SMS-receive tariffs (JSON); --cheapest ranks countries")
  .option("--apikey <key>", "onlinesim API key")
  .option("--country <code>", "Country code filter")
  .option("--service <name>", "Service name filter (e.g. amazon, telegram)")
  .option("--cheapest", "Rank in-stock countries by price for --service")
  .option("--limit <n>", "Max rows with --cheapest", "15")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimTariffsCommand({
      apikey: opts.apikey || parent.apikey,
      country: opts.country,
      service: opts.service,
      cheapest: opts.cheapest,
      limit: opts.limit,
      json: opts.json,
    });
  });

onlinesim
  .command("number")
  .description(
    "Order a number (cheapest country by default; --country to pin; --rent to rent)",
  )
  .option("--apikey <key>", "onlinesim API key")
  .option("--service <name>", "Service slug (default amazon or config)")
  .option("--country <code>", "Pin country code (skips cheapest search)")
  .option(
    "--cheapest",
    "Force cheapest-country search (default when --country omitted)",
  )
  .option("--max-attempts <n>", "Max countries to try when cheapest", "8")
  .option("--rent", "Rent mode instead of single-service SMS")
  .option("--days <n>", "Rent duration days (with --rent)", "1")
  .option("--wait", "Block until SMS code arrives")
  .option("--timeout <sec>", "Wait timeout seconds", "180")
  .option("--no-finish", "With --wait, do not setOperationOk after code")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimNumberCommand({
      apikey: opts.apikey || parent.apikey,
      service: opts.service,
      country: opts.country,
      cheapest: opts.cheapest,
      maxAttempts: opts.maxAttempts,
      rent: opts.rent,
      days: opts.days,
      wait: opts.wait,
      timeout: opts.timeout,
      finish: opts.finish,
      json: opts.json,
    });
  });

onlinesim
  .command("state")
  .description("Show active operations / last SMS (getState)")
  .option("--apikey <key>", "onlinesim API key")
  .option("--tzid <id>", "Operation id (default: last from config)")
  .option("--full", "Return full SMS body instead of code-only")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimStateCommand({
      apikey: opts.apikey || parent.apikey,
      tzid: opts.tzid,
      full: opts.full,
      json: opts.json,
    });
  });

onlinesim
  .command("wait")
  .description("Poll until an SMS code arrives for tzid")
  .option("--apikey <key>", "onlinesim API key")
  .option("--tzid <id>", "Operation id (default: last from config)")
  .option("--timeout <sec>", "Timeout seconds", "180")
  .option("--interval <sec>", "Poll interval seconds", "3")
  .option("--finish", "Call setOperationOk after code")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimWaitCommand({
      apikey: opts.apikey || parent.apikey,
      tzid: opts.tzid,
      timeout: opts.timeout,
      interval: opts.interval,
      finish: opts.finish,
      json: opts.json,
    });
  });

onlinesim
  .command("finish")
  .description("Close operation (setOperationOk)")
  .option("--apikey <key>", "onlinesim API key")
  .option("--tzid <id>", "Operation id (default: last from config)")
  .option("--ban", "Ban number if no SMS / bad format")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimFinishCommand({
      apikey: opts.apikey || parent.apikey,
      tzid: opts.tzid,
      ban: opts.ban,
      json: opts.json,
    });
  });

onlinesim
  .command("revise")
  .description("Request next SMS on the same number (setOperationRevise)")
  .option("--apikey <key>", "onlinesim API key")
  .option("--tzid <id>", "Operation id")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimReviseCommand({
      apikey: opts.apikey || parent.apikey,
      tzid: opts.tzid,
      json: opts.json,
    });
  });

onlinesim
  .command("rent-state")
  .description("Rent numbers state (getRentState) as JSON")
  .option("--apikey <key>", "onlinesim API key")
  .option("--tzid <id>", "Rent operation id")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimRentStateCommand({
      apikey: opts.apikey || parent.apikey,
      tzid: opts.tzid,
      json: opts.json,
    });
  });

onlinesim
  .command("rent-close")
  .description("Close a rented number")
  .option("--apikey <key>", "onlinesim API key")
  .option("--tzid <id>", "Rent operation id")
  .option("--json", "Machine-readable output")
  .action(async (opts, cmd) => {
    const parent = cmd.parent?.opts?.() ?? {};
    await onlinesimRentCloseCommand({
      apikey: opts.apikey || parent.apikey,
      tzid: opts.tzid,
      json: opts.json,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg, 1);
});
