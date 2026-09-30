import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import {
  CreateBucketCommand,
  GetBucketWebsiteCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Identity } from "./credentials.js";
import { runAws } from "./cli.js";
import { log } from "../ui.js";

export type DeployUrls = {
  pathStyle: string;
  virtualHosted: string;
  website?: string;
};

export type DeployResult = {
  bucket: string;
  prefix: string;
  region: string;
  urls: DeployUrls;
  objectCount: number;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function buildUrls(
  bucket: string,
  prefix: string,
  region: string,
  websiteHosting: boolean,
): DeployUrls {
  const key = `${prefix}/index.html`;
  const urls: DeployUrls = {
    pathStyle: `https://s3.amazonaws.com/${bucket}/${key}`,
    virtualHosted: `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
  };
  if (websiteHosting) {
    const host =
      region === "us-east-1"
        ? `${bucket}.s3-website-us-east-1.amazonaws.com`
        : `${bucket}.s3-website-${region}.amazonaws.com`;
    urls.website = `http://${host}/${prefix}/`;
  }
  return urls;
}

function clientFor(identity: Identity): S3Client {
  const config: S3ClientConfig = {
    region: identity.region,
  };
  // Prefer explicit profile so we match AWS CLI behavior
  if (identity.profile && identity.profile !== "default") {
    config.credentials = fromIni({ profile: identity.profile });
  } else if (identity.profile === "default") {
    config.credentials = fromIni({ profile: "default" });
  }
  return new S3Client(config);
}

export async function headBucket(
  identity: Identity,
  bucket: string,
): Promise<boolean> {
  const s3 = clientFor(identity);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === "NotFound" || name === "404") return false;
    // Wrong region / forbidden still means it may exist — surface later
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 404) return false;
    throw err;
  }
}

export async function ensureBucket(
  identity: Identity,
  bucket: string,
): Promise<void> {
  const exists = await headBucket(identity, bucket).catch(() => false);
  if (exists) {
    log.ok(`Bucket exists: s3://${bucket}`);
    return;
  }

  log.info(`Creating bucket s3://${bucket} in ${identity.region}…`);
  const s3 = clientFor(identity);

  if (identity.region === "us-east-1") {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } else {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: {
          LocationConstraint: identity.region as never,
        },
      }),
    );
  }
  log.ok(`Created s3://${bucket}`);
}

export async function enablePublicRead(
  identity: Identity,
  bucket: string,
  prefix?: string,
): Promise<void> {
  const s3 = clientFor(identity);

  log.warn("Disabling block-public-access on bucket (required for public objects)…");
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }),
  );

  const resource = prefix
    ? `arn:aws:s3:::${bucket}/${prefix}/*`
    : `arn:aws:s3:::${bucket}/*`;

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: resource,
      },
    ],
  };

  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify(policy),
    }),
  );
  log.ok(`Public read policy applied on ${resource}`);
}

export async function enableWebsiteHosting(
  identity: Identity,
  bucket: string,
): Promise<void> {
  const s3 = clientFor(identity);
  await s3.send(
    new PutBucketWebsiteCommand({
      Bucket: bucket,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: "index.html" },
        ErrorDocument: { Key: "index.html" },
      },
    }),
  );
  log.ok("Static website hosting enabled (index.html)");
}

export async function hasWebsiteHosting(
  identity: Identity,
  bucket: string,
): Promise<boolean> {
  const s3 = clientFor(identity);
  try {
    await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/**
 * Upload a local directory to s3://bucket/prefix/ using SDK (content-types).
 * For delete-stale behavior we also call `aws s3 sync --delete` when available.
 */
export async function deployDir(
  identity: Identity,
  opts: {
    dir: string;
    bucket: string;
    prefix: string;
    websiteHosting: boolean;
    useSyncDelete?: boolean;
  },
): Promise<DeployResult> {
  const root = opts.dir;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Deploy path is not a directory: ${root}`);
  }

  const prefix = opts.prefix.replace(/^\/|\/$/g, "");
  const files = listFilesRecursive(root);
  if (files.length === 0) {
    throw new Error(`No files found in ${root}`);
  }

  const indexAt = files.find((f) => relative(root, f).replace(/\\/g, "/") === "index.html");
  if (!indexAt) {
    log.warn("No index.html at directory root — URL may 404");
  }

  // Prefer aws s3 sync for --delete parity with CLI users
  if (opts.useSyncDelete !== false) {
    const dest = `s3://${opts.bucket}/${prefix}/`;
    log.info(`Syncing ${root} → ${dest}`);
    const r = await runAws(
      [
        "s3",
        "sync",
        root,
        dest,
        "--delete",
        "--only-show-errors",
      ],
      {
        profile: identity.profile === "default" ? undefined : identity.profile,
        region: identity.region,
        throwOnFail: true,
      },
    );
    if (r.stderr) log.dim(r.stderr);
  } else {
    const s3 = clientFor(identity);
    log.info(`Uploading ${files.length} file(s) to s3://${opts.bucket}/${prefix}/`);
    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, "/");
      const key = `${prefix}/${rel}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: createReadStream(file),
          ContentType: contentTypeFor(file),
          CacheControl: rel.endsWith(".html")
            ? "max-age=60"
            : "max-age=86400",
        }),
      );
    }
  }

  const urls = buildUrls(
    opts.bucket,
    prefix,
    identity.region,
    opts.websiteHosting,
  );

  return {
    bucket: opts.bucket,
    prefix,
    region: identity.region,
    urls,
    objectCount: files.length,
  };
}
