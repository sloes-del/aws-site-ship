import { confirm, input } from "@inquirer/prompts";
import { resolveIdentity } from "../aws/credentials.js";
import {
  enablePublicRead,
  enableWebsiteHosting,
  ensureBucket,
} from "../aws/s3.js";
import {
  defaultBucketName,
  loadConfig,
  saveConfig,
} from "../config.js";
import { fail, log, printJson } from "../ui.js";

export async function initCommand(opts: {
  profile?: string;
  region?: string;
  bucket?: string;
  public?: boolean;
  website?: boolean;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const identity = await resolveIdentity({
    profile: opts.profile,
    region: opts.region,
    trySso: true,
  });

  const cfg = loadConfig();
  let bucket =
    opts.bucket ||
    cfg.bucket ||
    defaultBucketName(identity.account);

  if (!opts.yes && !opts.bucket && !cfg.bucket) {
    bucket = await input({
      message: "S3 bucket name",
      default: bucket,
      validate: (v) =>
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v)
          ? true
          : "Invalid bucket name (3-63, lowercase, no underscores)",
    });
  }

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    fail(`Invalid bucket name: ${bucket}`, 1);
  }

  await ensureBucket(identity, bucket);

  let publicRead = Boolean(opts.public) || cfg.publicRead;
  let websiteHosting = Boolean(opts.website) || cfg.websiteHosting;

  if (!opts.yes) {
    if (opts.public === undefined) {
      publicRead = await confirm({
        message:
          "Make objects publicly readable? (needed for raw s3.amazonaws.com links)",
        default: publicRead,
      });
    }
    if (opts.website === undefined) {
      websiteHosting = await confirm({
        message: "Enable S3 static website hosting endpoint?",
        default: websiteHosting,
      });
    }
  }

  if (publicRead) {
    if (!opts.yes) {
      const sure = await confirm({
        message:
          "Confirm: disable block-public-access and attach a public GetObject policy?",
        default: false,
      });
      if (!sure) {
        publicRead = false;
        log.warn("Skipping public policy — deploys will be private");
      }
    }
    if (publicRead) {
      await enablePublicRead(identity, bucket);
    }
  }

  if (websiteHosting) {
    await enableWebsiteHosting(identity, bucket);
  }

  const saved = saveConfig({
    profile: identity.profile,
    region: identity.region,
    bucket,
    publicRead,
    websiteHosting,
  });

  if (opts.json) {
    printJson({ identity, config: saved });
    return;
  }

  log.title("Init complete");
  log.ok(`Bucket   s3://${bucket}`);
  log.ok(`Region   ${identity.region}`);
  log.ok(`Profile  ${identity.profile}`);
  log.ok(`Public   ${publicRead}`);
  log.ok(`Website  ${websiteHosting}`);
  log.dim("Next: aws-site-ship deploy ./dist --words hello world");
}
