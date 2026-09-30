import {
  assumeOrganizationAccessRole,
  createMemberAccount,
  provisionDeployUser,
} from "../aws/orgs.js";
import { resolveIdentity } from "../aws/credentials.js";
import { saveConfig } from "../config.js";
import { stampEmail } from "../headless.js";
import { fail, log, printJson } from "../ui.js";

export async function createAccountCommand(opts: {
  profile?: string;
  region?: string;
  /** Management / payer profile override */
  managementProfile?: string;
  email?: string;
  name?: string;
  roleName?: string;
  /** Local CLI profile to write member IAM keys into */
  memberProfile?: string;
  /** Skip IAM user; only create account + print id */
  skipIam?: boolean;
  admin?: boolean;
  /** Auto plus-address stamp on email */
  stamp?: boolean;
  json?: boolean;
  yes?: boolean;
}): Promise<void> {
  // Headless: every required field must come from flags/env — no prompts
  const emailRaw =
    opts.email ||
    process.env.AWS_SITE_SHIP_ACCOUNT_EMAIL ||
    process.env.AWS_ACCOUNT_EMAIL;
  const accountName =
    opts.name ||
    process.env.AWS_SITE_SHIP_ACCOUNT_NAME ||
    process.env.AWS_ACCOUNT_NAME ||
    `site-ship-${Date.now().toString(36)}`;

  if (!emailRaw) {
    fail(
      "Headless create-account needs --email (or AWS_SITE_SHIP_ACCOUNT_EMAIL).\n" +
        "  This uses AWS Organizations CreateAccount on an existing management account.\n" +
        "  Brand-new root signup still cannot be 100% API-only (phone/payment/CAPTCHA).",
      1,
    );
  }

  const email =
    opts.stamp !== false && process.env.AWS_SITE_SHIP_NO_STAMP !== "1"
      ? stampEmail(emailRaw)
      : emailRaw;

  const region =
    opts.region ||
    process.env.AWS_REGION ||
    process.env.AWS_SITE_SHIP_REGION ||
    "us-east-1";

  const managementProfile =
    opts.managementProfile ||
    opts.profile ||
    process.env.AWS_SITE_SHIP_MGMT_PROFILE ||
    process.env.AWS_PROFILE;

  const memberProfile =
    opts.memberProfile ||
    process.env.AWS_SITE_SHIP_MEMBER_PROFILE ||
    "aws-site-ship";

  const identity = await resolveIdentity({
    profile: managementProfile,
    region,
    trySso: true,
  });

  log.title("Headless account create (Organizations)");
  log.info(`Management account ${identity.account} · ${identity.arn}`);
  log.info(`New account email  ${email}`);
  log.info(`New account name   ${accountName}`);

  const created = await createMemberAccount(identity, {
    email,
    accountName,
    roleName: opts.roleName,
  });

  let iam:
    | {
        userName: string;
        profile: string;
        accessKeyId: string;
      }
    | undefined;

  if (!opts.skipIam) {
    const member = await assumeOrganizationAccessRole(identity, {
      accountId: created.accountId,
      roleName: opts.roleName,
      region,
    });

    const user = await provisionDeployUser({
      member,
      region,
      profile: memberProfile,
      admin: opts.admin !== false,
    });

    iam = {
      userName: user.userName,
      profile: user.profile,
      accessKeyId: user.accessKeyId,
    };

    saveConfig({
      profile: memberProfile,
      region,
      lastMemberAccountId: created.accountId,
      lastMemberEmail: email,
      lastMemberProfile: memberProfile,
    });
  }

  const payload = {
    ok: true,
    mode: "organizations-create-account",
    managementAccountId: identity.account,
    accountId: created.accountId,
    accountName: created.accountName,
    email: created.email,
    requestId: created.requestId,
    memberProfile: iam?.profile,
    iamUser: iam?.userName,
    accessKeyId: iam?.accessKeyId,
    next: iam
      ? `aws-site-ship init --profile ${iam.profile} --public --website -y && aws-site-ship deploy ./fixtures/site --words hello world --profile ${iam.profile}`
      : `Assume role OrganizationAccountAccessRole in ${created.accountId}`,
  };

  if (opts.json) {
    printJson(payload);
    return;
  }

  log.title("Account created (headless)");
  log.ok(`AccountId   ${payload.accountId}`);
  log.ok(`Email       ${payload.email}`);
  if (iam) {
    log.ok(`CLI profile ${iam.profile}`);
    log.ok(`IAM user    ${iam.userName}`);
    log.ok(`Access key  ${iam.accessKeyId}`);
    log.dim("Secret key written via aws configure set (not printed)");
  }
  log.dim(payload.next);
}
