import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  OrganizationsClient,
  type CreateAccountState,
} from "@aws-sdk/client-organizations";
import {
  AssumeRoleCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import {
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreateUserCommand,
  IAMClient,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Identity } from "./credentials.js";
import { writeAccessKeys } from "./credentials.js";
import { log } from "../ui.js";

export type CreateAccountResult = {
  accountId: string;
  accountName: string;
  email: string;
  state: CreateAccountState | string;
  requestId: string;
};

export type MemberAccess = {
  accountId: string;
  /** Temporary session from OrganizationAccountAccessRole */
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
};

export type MemberIamUser = {
  accountId: string;
  userName: string;
  accessKeyId: string;
  secretAccessKey: string;
  profile: string;
};

function orgClient(identity: Identity): OrganizationsClient {
  return new OrganizationsClient({
    region: "us-east-1", // Organizations is global, endpoint via us-east-1
    credentials:
      identity.profile && identity.profile !== "default"
        ? fromIni({ profile: identity.profile })
        : fromIni({ profile: "default" }),
  });
}

function stsClient(identity: Identity, region: string): STSClient {
  return new STSClient({
    region,
    credentials:
      identity.profile && identity.profile !== "default"
        ? fromIni({ profile: identity.profile })
        : fromIni({ profile: "default" }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Headless member-account creation via AWS Organizations.
 * Requires management-account credentials with organizations:CreateAccount.
 * Email must be unique and deliverable (AWS still sends the handshake mail,
 * but CreateAccount itself is API-complete — no browser/CAPTCHA).
 */
export async function createMemberAccount(
  identity: Identity,
  opts: {
    email: string;
    accountName: string;
    /** IAM role name created in the new account for the management account to assume */
    roleName?: string;
    iamUserAccessToBilling?: "ALLOW" | "DENY";
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<CreateAccountResult> {
  const roleName = opts.roleName ?? "OrganizationAccountAccessRole";
  const client = orgClient(identity);

  log.info(
    `Organizations CreateAccount: "${opts.accountName}" <${opts.email}>`,
  );

  const created = await client.send(
    new CreateAccountCommand({
      Email: opts.email,
      AccountName: opts.accountName,
      RoleName: roleName,
      IamUserAccessToBilling: opts.iamUserAccessToBilling ?? "ALLOW",
    }),
  );

  const requestId = created.CreateAccountStatus?.Id;
  if (!requestId) {
    throw new Error("CreateAccount returned no request id");
  }

  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 10_000;
  const started = Date.now();

  let state: CreateAccountState | string =
    created.CreateAccountStatus?.State ?? "IN_PROGRESS";
  let accountId = created.CreateAccountStatus?.AccountId ?? "";
  let failureReason = created.CreateAccountStatus?.FailureReason;

  while (state === "IN_PROGRESS") {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `CreateAccount timed out after ${timeoutMs}ms (request ${requestId})`,
      );
    }
    log.dim(`  waiting for account… (${requestId})`);
    await sleep(pollMs);
    const status = await client.send(
      new DescribeCreateAccountStatusCommand({
        CreateAccountRequestId: requestId,
      }),
    );
    state = status.CreateAccountStatus?.State ?? "IN_PROGRESS";
    accountId = status.CreateAccountStatus?.AccountId ?? accountId;
    failureReason = status.CreateAccountStatus?.FailureReason;
  }

  if (state !== "SUCCEEDED" || !accountId) {
    throw new Error(
      `CreateAccount ${state}: ${failureReason ?? "unknown"} (request ${requestId})`,
    );
  }

  log.ok(`Account ready: ${accountId}`);
  return {
    accountId,
    accountName: opts.accountName,
    email: opts.email,
    state,
    requestId,
  };
}

/**
 * Assume OrganizationAccountAccessRole in a member account (headless).
 */
export async function assumeOrganizationAccessRole(
  identity: Identity,
  opts: {
    accountId: string;
    roleName?: string;
    sessionName?: string;
    region?: string;
    durationSeconds?: number;
  },
): Promise<MemberAccess> {
  const roleName = opts.roleName ?? "OrganizationAccountAccessRole";
  const region = opts.region ?? identity.region ?? "us-east-1";
  const sts = stsClient(identity, region);
  const roleArn = `arn:aws:iam::${opts.accountId}:role/${roleName}`;

  log.info(`Assuming ${roleArn}`);

  // New accounts sometimes need a few seconds before AssumeRole works
  let lastErr: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      const out = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: opts.sessionName ?? "aws-site-ship",
          DurationSeconds: opts.durationSeconds ?? 3600,
        }),
      );
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new Error("AssumeRole returned incomplete credentials");
      }
      return {
        accountId: opts.accountId,
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration,
      };
    } catch (err) {
      lastErr = err;
      log.dim(`  AssumeRole not ready, retry ${i + 1}/12…`);
      await sleep(5_000);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`AssumeRole failed: ${String(lastErr)}`);
}

/**
 * Inside the member account: create a long-lived IAM user + access keys
 * and write them to a local AWS CLI profile (fully headless thereafter).
 */
export async function provisionDeployUser(opts: {
  member: MemberAccess;
  region: string;
  userName?: string;
  profile: string;
  /** Attach AdministratorAccess (lab) or a tight inline policy */
  admin?: boolean;
  bucketPrefix?: string;
}): Promise<MemberIamUser> {
  const userName = opts.userName ?? "site-ship-deploy";
  const creds = {
    accessKeyId: opts.member.accessKeyId,
    secretAccessKey: opts.member.secretAccessKey,
    sessionToken: opts.member.sessionToken,
  };

  const iam = new IAMClient({ region: opts.region, credentials: creds });

  log.info(`Creating IAM user ${userName} in ${opts.member.accountId}`);
  try {
    await iam.send(new CreateUserCommand({ UserName: userName }));
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name !== "EntityAlreadyExistsException") throw err;
    log.warn(`IAM user ${userName} already exists — rotating access key path`);
  }

  if (opts.admin !== false) {
    await iam.send(
      new AttachUserPolicyCommand({
        UserName: userName,
        PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
      }),
    );
  } else {
    const bucketPrefix = opts.bucketPrefix ?? "site-ship-";
    await iam.send(
      new PutUserPolicyCommand({
        UserName: userName,
        PolicyName: "SiteShipDeploy",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:*"],
              Resource: [
                `arn:aws:s3:::${bucketPrefix}*`,
                `arn:aws:s3:::${bucketPrefix}*/*`,
              ],
            },
            {
              Effect: "Allow",
              Action: ["sts:GetCallerIdentity"],
              Resource: "*",
            },
          ],
        }),
      }),
    );
  }

  const key = await iam.send(
    new CreateAccessKeyCommand({ UserName: userName }),
  );
  const accessKeyId = key.AccessKey?.AccessKeyId;
  const secretAccessKey = key.AccessKey?.SecretAccessKey;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("CreateAccessKey returned empty key material");
  }

  await writeAccessKeys({
    profile: opts.profile,
    accessKeyId,
    secretAccessKey,
    region: opts.region,
  });

  log.ok(`IAM user ready · CLI profile "${opts.profile}"`);
  return {
    accountId: opts.member.accountId,
    userName,
    accessKeyId,
    secretAccessKey,
    profile: opts.profile,
  };
}
