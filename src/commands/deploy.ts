import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveIdentity } from "../aws/credentials.js";
import { deployDir, ensureBucket } from "../aws/s3.js";
import {
  defaultBucketName,
  loadConfig,
  saveConfig,
} from "../config.js";
import { fail, log, printJson } from "../ui.js";
import {
  joinWords,
  randomWordPair,
  wordsFromSiteName,
} from "../words.js";

function guessWordsFromPackage(): string | null {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    if (pkg.name) return wordsFromSiteName(pkg.name.replace(/^@[^/]+\//, ""));
  } catch {
    /* ignore */
  }
  return null;
}

export async function deployCommand(
  dirArg: string | undefined,
  opts: {
    profile?: string;
    region?: string;
    bucket?: string;
    words?: string[];
    prefix?: string;
    joiner?: string;
    unique?: boolean;
    yes?: boolean;
    json?: boolean;
  },
): Promise<void> {
  const dir = resolve(dirArg || "./dist");
  if (!existsSync(dir)) {
    fail(
      `Directory not found: ${dir}\n  Create a static build (e.g. index.html) or pass a path.`,
      4,
    );
  }

  const identity = await resolveIdentity({
    profile: opts.profile,
    region: opts.region,
    trySso: true,
  });

  const cfg = loadConfig();
  const bucket =
    opts.bucket || cfg.bucket || defaultBucketName(identity.account);

  if (!cfg.bucket && !opts.bucket) {
    log.warn(`No bucket in config — using ${bucket} (run init to pin one)`);
  }

  await ensureBucket(identity, bucket);

  const joiner = opts.joiner ?? "-";
  let prefix = opts.prefix?.replace(/^\/|\/$/g, "");

  if (!prefix) {
    if (opts.words && opts.words.length >= 2) {
      prefix = joinWords(opts.words[0]!, opts.words[1]!, joiner, opts.unique);
    } else if (opts.words && opts.words.length === 1) {
      prefix = joinWords(opts.words[0]!, "site", joiner, opts.unique);
    } else {
      prefix =
        guessWordsFromPackage() ||
        randomWordPair(joiner, Boolean(opts.unique));
    }
  }

  log.info(`Deploy prefix: ${prefix}`);

  const result = await deployDir(identity, {
    dir,
    bucket,
    prefix,
    websiteHosting: cfg.websiteHosting,
    useSyncDelete: true,
  });

  saveConfig({
    profile: identity.profile,
    region: identity.region,
    bucket,
    lastDeploy: {
      prefix: result.prefix,
      url: result.urls.pathStyle,
      at: new Date().toISOString(),
    },
  });

  if (opts.json) {
    printJson(result);
    return;
  }

  log.title("Deployed");
  log.ok(`${result.objectCount} local file(s) → s3://${bucket}/${prefix}/`);
  log.blank();
  log.info("URLs:");
  console.log(`  path-style     ${result.urls.pathStyle}`);
  console.log(`  virtual-hosted ${result.urls.virtualHosted}`);
  if (result.urls.website) {
    console.log(`  website        ${result.urls.website}`);
  }
  if (!cfg.publicRead) {
    log.blank();
    log.warn(
      "Bucket may be private. If the link 403s, re-run: aws-site-ship init --public",
    );
  }
}
