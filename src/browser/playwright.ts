/**
 * Isolated Playwright Chromium — separate user-data dir so we never touch
 * the user's everyday Chrome profile / cookies / main browser window.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const AWS_SIGNUP_URL =
  "https://signin.aws.amazon.com/signup?request_type=register";

export type AwsSignupFormInput = {
  email: string;
  accountName: string;
  password: string;
  phone?: string;
  /** Keep browser open for CAPTCHA / payment (default true) */
  holdForHuman?: boolean;
  headless?: boolean;
};

export type AwsSignupBrowserResult = {
  url: string;
  filled: string[];
  skipped: string[];
  note: string;
  userDataDir: string;
};

function profileDir(): string {
  // Unique subdir per run avoids "profile already in use" locks
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const dir = join(homedir(), ".aws-site-ship", "pw-chromium", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function tryFill(
  page: Page,
  selectors: string[],
  value: string,
  label: string,
  filled: string[],
  skipped: string[],
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 2000 }).catch(() => undefined);
      await loc.fill(value, { timeout: 5000 });
      filled.push(label);
      return true;
    } catch {
      /* try next selector */
    }
  }
  skipped.push(label);
  return false;
}

async function tryClick(
  page: Page,
  selectors: string[],
  label: string,
  filled: string[],
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 3000 });
      filled.push(label);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * Launch isolated Chromium and drive the first AWS root-signup screens.
 * Stops before CAPTCHA / payment — those stay human in this same window.
 */
export async function runAwsSignupWithPlaywright(
  input: AwsSignupFormInput,
): Promise<{
  result: AwsSignupBrowserResult;
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}> {
  const userDataDir = profileDir();
  const headless = Boolean(input.headless);

  // Persistent context = isolated profile, not the OS default browser
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: undefined,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] || (await context.newPage());
  const filled: string[] = [];
  const skipped: string[] = [];

  await page.goto(AWS_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);

  // Step 1: email + account name (AWS layout drifts — try several selectors)
  await tryFill(
    page,
    [
      '#emailAddress',
      'input[name="emailAddress"]',
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="mail" i]',
    ],
    input.email,
    "email",
    filled,
    skipped,
  );

  await tryFill(
    page,
    [
      '#accountName',
      'input[name="accountName"]',
      'input[name="awsAccountName"]',
      'input[placeholder*="account" i]',
      'input[aria-label*="account name" i]',
    ],
    input.accountName,
    "accountName",
    filled,
    skipped,
  );

  await tryClick(
    page,
    [
      'button:has-text("Verify email")',
      'button:has-text("Verify email address")',
      'button:has-text("Continue")',
      'input[type="submit"]',
      'button[type="submit"]',
    ],
    "clicked-continue",
    filled,
  );

  await page.waitForTimeout(2000);

  // Password screens (may appear after email verify — best-effort)
  await tryFill(
    page,
    [
      '#password',
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="new-password"]',
    ],
    input.password,
    "password",
    filled,
    skipped,
  );
  await tryFill(
    page,
    [
      '#passwordConfirm',
      '#confirmPassword',
      'input[name="passwordConfirm"]',
      'input[name="confirmPassword"]',
      'input[autocomplete="new-password"] >> nth=1',
    ],
    input.password,
    "passwordConfirm",
    filled,
    skipped,
  );

  if (input.phone) {
    const digits = input.phone.replace(/[^\d+]/g, "");
    await tryFill(
      page,
      [
        '#phoneNumber',
        'input[name="phoneNumber"]',
        'input[type="tel"]',
        'input[autocomplete="tel"]',
        'input[placeholder*="phone" i]',
      ],
      digits,
      "phone",
      filled,
      skipped,
    );
  }

  const result: AwsSignupBrowserResult = {
    url: page.url(),
    filled,
    skipped,
    userDataDir,
    note:
      "Playwright used isolated ~/.aws-site-ship/pw-chromium (not your main browser). CAPTCHA/payment remain human in this window.",
  };

  return { result, browser: null, context, page };
}

export async function revealMercuryCardInPlaywright(
  context: BrowserContext,
  cardId?: string,
): Promise<string> {
  const page = await context.newPage();
  const url = cardId
    ? `https://app.mercury.com/cards`
    : "https://app.mercury.com/cards";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page.url();
}
