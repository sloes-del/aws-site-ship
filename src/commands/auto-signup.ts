import { randomBytes } from "node:crypto";
import open from "open";
import {
  OnlineSimClient,
  OnlineSimError,
  resolveOnlineSimApiKey,
} from "../onlinesim/client.js";
import {
  MercuryClient,
  resolveMercuryToken,
  defaultDebitPolicy,
  MERCURY_CARDS_URL,
} from "../mercury/client.js";
import {
  TEMP_TF_URL,
  TempMailClient,
  TempMailError,
  extractEmailCode,
  extractVerifyLink,
} from "../tempmail/client.js";
import { loadConfig, saveConfig } from "../config.js";
import { stampEmail } from "../headless.js";
import { fail, log, printJson } from "../ui.js";

const AWS_SIGNUP_URL =
  "https://signin.aws.amazon.com/signup?request_type=register";

function randPassword(): string {
  return `Aw5-${randomBytes(9).toString("base64url")}!a1`;
}

/**
 * Best-effort AWS root auto-signup pack:
 *  - disposable email (mail.tm API; temp.tf opened in browser — no temp.tf API)
 *  - OnlineSim cheapest Amazon number + optional SMS wait
 *  - Mercury $1/day virtual debit (cancel next day)
 *  - Opens AWS signup in a real browser
 *
 * Does NOT solve CAPTCHA or submit the AWS form via Puppeteer.
 */
export async function autoSignupCommand(opts: {
  email?: string;
  accountName?: string;
  service?: string;
  /** reuse existing onlinesim tzid */
  tzid?: string;
  number?: string;
  waitSms?: boolean;
  waitEmail?: boolean;
  timeout?: string;
  skipMercury?: boolean;
  skipPhone?: boolean;
  skipEmail?: boolean;
  noOpen?: boolean;
  openTempTf?: boolean;
  json?: boolean;
}): Promise<void> {
  const timeoutMs = Number(opts.timeout || 180) * 1000;
  const service = opts.service || "amazon";
  const cfg = loadConfig();

  const pack: {
    ok: boolean;
    mode: string;
    accountName: string;
    password: string;
    email?: {
      address: string;
      password: string;
      provider: string;
      inboxUrl?: string;
    };
    phone?: {
      number?: string;
      tzid?: number;
      country?: string;
      service: string;
      code?: string;
      fullMessage?: string;
    };
    mercury?: {
      cardId?: string;
      lastFour?: string;
      amountCents: number;
      cancelAt?: string;
      dashboard: string;
    };
    aws: {
      signupUrl: string;
      manualGates: string[];
    };
    next: string[];
  } = {
    ok: true,
    mode: "auto-signup-assisted",
    accountName:
      opts.accountName ||
      process.env.AWS_SITE_SHIP_ACCOUNT_NAME ||
      `site-ship-${Date.now().toString(36)}`,
    password: randPassword(),
    aws: {
      signupUrl: AWS_SIGNUP_URL,
      manualGates: [
        "CAPTCHA / fraud challenge",
        "Payment method confirmation (use Mercury card in browser)",
        "Final human clicks in the opened AWS signup tab",
      ],
    },
    next: [],
  };

  log.title("auto-signup (assisted — no CAPTCHA solver)");
  log.warn(
    "AWS root CAPTCHA stays human. We auto-provision email + SMS + $1 Mercury card and open the browser.",
  );

  // ── Email (mail.tm API) ─────────────────────────────────────────
  if (!opts.skipEmail) {
    try {
      if (opts.email) {
        const address =
          process.env.AWS_SITE_SHIP_NO_STAMP === "1"
            ? opts.email
            : stampEmail(opts.email);
        pack.email = {
          address,
          password: "(your inbox)",
          provider: "provided",
        };
        log.ok(`Email (provided) ${address}`);
      } else {
        log.info("Creating disposable inbox via mail.tm API…");
        log.dim(
          `(temp.tf has no public API — use --open-temp-tf to open ${TEMP_TF_URL} in browser)`,
        );
        const tm = new TempMailClient();
        const inbox = await tm.createInbox();
        pack.email = {
          address: inbox.address,
          password: inbox.password,
          provider: "mail.tm",
          inboxUrl: "https://mail.tm/",
        };
        saveConfig({
          lastTempMail: {
            id: inbox.id,
            address: inbox.address,
            password: inbox.password,
            token: inbox.token,
            provider: "mail.tm",
            at: new Date().toISOString(),
          },
        });
        log.ok(`Email ${inbox.address}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`temp mail failed: ${msg}`);
      log.dim(`Open ${TEMP_TF_URL} in browser and copy an address manually.`);
      pack.next.push(`Use a temp.tf address from ${TEMP_TF_URL}`);
    }
  }

  if (opts.openTempTf) {
    log.info(`Opening temp.tf in browser: ${TEMP_TF_URL}`);
    await open(TEMP_TF_URL);
  }

  // ── Phone (onlinesim) ───────────────────────────────────────────
  if (!opts.skipPhone) {
    const apiKey = resolveOnlineSimApiKey() || cfg.onlinesimApiKey;
    if (!apiKey) {
      fail("ONLINESIM_API_KEY missing in .env", 2);
    }
    const os = new OnlineSimClient({ apiKey, lang: "en" });
    try {
      let tzid = opts.tzid ? Number(opts.tzid) : cfg.lastOnlineSim?.tzid;
      let number = opts.number || cfg.lastOnlineSim?.number;
      let country = cfg.lastOnlineSim?.country;

      if (!tzid || !number) {
        log.info(`Ordering cheapest ${service} number…`);
        const got = await os.getNumCheapest({
          service,
          number: true,
          onAttempt: (offer, i, err) => {
            if (!err && i === 0) {
              log.info(
                `  try country ${offer.country} @ ${offer.price}`,
              );
            }
          },
        });
        tzid = got.tzid;
        number = got.number;
        country = String(got.offer.country);
        saveConfig({
          lastOnlineSim: {
            tzid,
            number,
            service,
            country,
            mode: "sms",
            at: new Date().toISOString(),
          },
        });
      } else {
        log.info(`Reusing onlinesim tzid=${tzid} number=${number}`);
      }

      pack.phone = {
        number,
        tzid,
        country,
        service,
      };

      if (opts.waitSms) {
        log.info(`Waiting for SMS on ${number} (timeout ${timeoutMs / 1000}s)…`);
        const sms = await os.waitForSms({
          tzid: tzid!,
          timeoutMs,
          fullMessage: true,
          onTick: (st, attempt) => {
            if (attempt === 1 || attempt % 5 === 0) {
              log.dim(
                `  sms poll #${attempt} ${st?.response ?? "?"} msg=${st?.msg ? "yes" : "no"}`,
              );
            }
          },
        });
        pack.phone.code = sms.code;
        pack.phone.fullMessage = sms.fullMessage;
        log.ok(`SMS code ${sms.code}`);
      } else {
        log.dim(
          `When AWS sends the code: aws-site-ship onlinesim wait --tzid ${tzid} --json`,
        );
        pack.next.push(
          `aws-site-ship onlinesim wait --tzid ${tzid} --json`,
        );
      }
    } catch (e) {
      if (e instanceof OnlineSimError) {
        fail(`onlinesim ${e.code}`, 3);
      }
      throw e;
    }
  }

  // ── Mercury $1 card ─────────────────────────────────────────────
  if (!opts.skipMercury) {
    const token = resolveMercuryToken() || cfg.mercuryApiToken;
    if (!token) {
      log.warn("MERCURY_API_TOKEN missing — skipping card");
    } else {
      try {
        const mercury = new MercuryClient({ token });
        const policy = defaultDebitPolicy();
        const account = await mercury.pickDebitAccount(cfg.mercuryAccountId);
        const user = await mercury.pickUser(cfg.mercuryUserId);
        log.info("Issuing Mercury virtual debit ($1 / daily, cancel next midnight)…");
        const card = await mercury.createDebitCard({
          accountId: account.id,
          userId: user.id,
          amountCents: 100,
          interval: "daily",
          nickname: `aws-signup-${pack.accountName}`.slice(0, 40),
        });
        saveConfig({
          mercuryAccountId: account.id,
          mercuryUserId: user.id,
          lastMercuryCard: {
            id: card.id,
            lastFour: card.lastFour,
            accountId: card.accountId,
            userId: card.userId,
            nickname: card.nickname ?? undefined,
            amountCents: 100,
            interval: "daily",
            cancelAt: policy.cancelAt,
            status: card.status,
            at: new Date().toISOString(),
          },
        });
        pack.mercury = {
          cardId: card.id,
          lastFour: card.lastFour,
          amountCents: 100,
          cancelAt: policy.cancelAt,
          dashboard: MERCURY_CARDS_URL,
        };
        log.ok(`Mercury card *${card.lastFour} id=${card.id}`);
        log.dim("Reveal PAN/CVC in browser (or mercury reveal if agent card)");
        pack.next.push("aws-site-ship mercury open --cards");
        pack.next.push("aws-site-ship mercury cancel-due   # after cancelAt");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`Mercury card failed: ${msg}`);
        if (/ipNotWhitelisted|whitelist/i.test(msg)) {
          log.warn(
            "Mercury token IP whitelist blocked this machine — add your IP in the dashboard (browser).",
          );
          log.dim("  aws-site-ship mercury open --tokens");
          if (!opts.noOpen) {
            await open("https://app.mercury.com/settings/tokens");
          }
        }
        log.dim("Continue signup; add payment manually in AWS browser flow.");
      }
    }
  }

  // ── Open AWS signup (real browser) ──────────────────────────────
  if (!opts.noOpen) {
    log.info(`Opening AWS signup: ${AWS_SIGNUP_URL}`);
    await open(AWS_SIGNUP_URL);
    if (pack.mercury) {
      await open(MERCURY_CARDS_URL);
    }
  }

  // ── Optional email wait ─────────────────────────────────────────
  const lastMail = loadConfig().lastTempMail;
  if (opts.waitEmail && lastMail?.token) {
    try {
      log.info("Waiting for AWS verification email…");
      const tm = new TempMailClient();
      const msg = await tm.waitForMessage({
        token: lastMail.token,
        timeoutMs,
        match: /amazon|aws|verify|confirm/i,
        onTick: (n, attempt) => {
          if (attempt === 1 || attempt % 5 === 0) {
            log.dim(`  email poll #${attempt} messages=${n}`);
          }
        },
      });
      const link = extractVerifyLink(msg);
      const code = extractEmailCode(msg);
      log.ok(`Email subject: ${msg.subject}`);
      if (code) log.ok(`Email code: ${code}`);
      if (link) {
        log.ok(`Verify link: ${link}`);
        if (!opts.noOpen) await open(link);
      }
      (pack as { emailMessage?: unknown }).emailMessage = {
        subject: msg.subject,
        code,
        link,
      };
    } catch (e) {
      log.warn(
        `Email wait: ${e instanceof Error ? e.message : String(e)}`,
      );
      pack.next.push("aws-site-ship auto-signup --wait-email   # retry poll");
    }
  }

  pack.next.push(
    "Fill AWS form in browser with printed email / phone / password / Mercury card",
  );
  pack.next.push(
    "After account exists: aws-site-ship auth -y  then  aws-site-ship headless --dir ./fixtures/site --words forest lamp --website",
  );

  saveConfig({
    lastAutoSignup: {
      accountName: pack.accountName,
      email: pack.email?.address,
      phone: pack.phone?.number,
      tzid: pack.phone?.tzid,
      mercuryCardId: pack.mercury?.cardId,
      at: new Date().toISOString(),
    },
  });

  if (opts.json) {
    printJson(pack);
    return;
  }

  log.blank();
  log.title("Signup pack — paste into AWS browser form");
  console.log(`  Account name  ${pack.accountName}`);
  console.log(`  Password      ${pack.password}`);
  if (pack.email) console.log(`  Email         ${pack.email.address}`);
  if (pack.phone?.number) console.log(`  Phone         ${pack.phone.number}`);
  if (pack.phone?.code) console.log(`  SMS code      ${pack.phone.code}`);
  if (pack.mercury) {
    console.log(
      `  Card          Mercury *${pack.mercury.lastFour} ($1/day) → ${pack.mercury.dashboard}`,
    );
  }
  log.blank();
  log.warn("You still click CAPTCHA + finish payment in the browser tab.");
  for (const n of pack.next) log.dim(`  next: ${n}`);
}
