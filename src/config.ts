import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ShipConfig = {
  profile: string;
  region: string;
  bucket: string;
  publicRead: boolean;
  websiteHosting: boolean;
  lastDeploy?: {
    prefix: string;
    url: string;
    at: string;
  };
  /** Last Organizations member account provisioned headlessly */
  lastMemberAccountId?: string;
  lastMemberEmail?: string;
  lastMemberProfile?: string;
  /**
   * onlinesim.io API key (optional local convenience).
   * Prefer ONLINESIM_API_KEY env in CI — this field is never printed by whoami.
   */
  onlinesimApiKey?: string;
  onlinesimDefaultCountry?: string;
  onlinesimDefaultService?: string;
  lastOnlineSim?: {
    tzid: number;
    number?: string;
    service?: string;
    country?: string;
    mode?: "sms" | "rent";
    at: string;
  };
};

const DIR = join(homedir(), ".aws-site-ship");
const FILE = join(DIR, "config.json");

const DEFAULTS: ShipConfig = {
  profile: "",
  region: "us-east-1",
  bucket: "",
  publicRead: false,
  websiteHosting: false,
};

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function configPath(): string {
  return FILE;
}

export function loadConfig(): ShipConfig {
  ensureDir();
  if (!existsSync(FILE)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<ShipConfig>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig( partial: Partial<ShipConfig>): ShipConfig {
  ensureDir();
  const next = { ...loadConfig(), ...partial };
  writeFileSync(FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function defaultBucketName(accountId: string): string {
  return `site-ship-${accountId}`;
}
