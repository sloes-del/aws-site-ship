import { writeFileSync } from "node:fs";

const src = `import { randomBytes } from "node:crypto";
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
  extractEmailCode,
  extractVerifyLink,
} from "../tempmail/client.js";
import { runAwsSignupWithPlaywright } from "../browser/playwright.js";
import { loadConfig, saveConfig } from "../config.js";
import { stampEmail } from "../headless.js";
import { fail, log, printJson } from "../ui.js";

const AWS_SIGNUP_URL =
  "https://signin.aws.amazon.com/signup?request_type=register";

function randPassword(): string {
  return \`Aw5-\${randomBytes(9).toString("base64url")}!a1\`;
}

export async function autoSignupCommand(opts: {
  email?: string;
  accountName?: string;
  service?: string;
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
  playwright?: boolean;
  headless?: boolean;
  freshPhone?: boolean;
  json?: boolean;
}): Promise<void> {
  const timeoutMs = Number(opts.timeout || 180) * 1000;
  const service = opts.service || "amazon";
  const cfg = loadConfig();
  const usePlaywright =
    Boolean(opts.playwright) || process.env.AWS_SITE_SHIP_PLAYWRIGHT === "1";

  const pack: {
    ok: boolean;
    mode: string;
    accountName: string;
    password: string;
    email?: { address: string; password: string; provider: string; inboxUrl?: string };
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
    playwright?: {
      url: string;
      filled: string[];
      skipped: string[];
      userDataDir: string;
      note: string;
    };
    aws: { signupUrl: string; manualGates: string[] };
    next: string[];
  } = {
    ok: true,
    mode: usePlaywright ? "auto-signup-playwright" : "auto-signup-assisted",
    accountName:
      opts.accountName ||
      process.env.AWS_SITE_SHIP_ACCOUNT_NAME ||
      \`site-ship-\${Date.now().toString(36)}\`,
    password: randPassword(),
    aws: {
      signupUrl: AWS_SIGNUP_URL,
      manualGates: [
        "CAPTCHA / fraud challenge (in Playwright window if --playwright)",
        "Payment method confirmation (Mercury card PAN from dashboard / reveal)",
        "Final human clicks",
      ],
    },
    next: [],
  };

  log.title(
    usePlaywright
      ? "auto-signup (Playwright isolated Chromium)"
      : "auto-signup (assisted)",
  );
  if (usePlaywright) {
    log.ok("Using Playwright profile under ~/.aws-site-ship/pw-chromium — not your main browser.");
  }

  if (opts.email) {
    const address =
      process.env.AWS_SITE_SHIP_NO_STAMP === "1" ? opts.email : stampEmail(opts.email);
    pack.email = { address, password: "(your inbox)", provider: "provided" };
    log.ok(\`Email (provided) \${address}\`);
  } else if (!opts.skipEmail) {
    try {
      log.info("Creating disposable inbox via mail.tm API…");
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
      log.ok(\`Email \${inbox.address}\`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(\`temp mail failed: \${msg}\`);
      pack.next.push(\`Use a temp.tf address from \${TEMP_TF_URL}\`);
    }
  }

  if (opts.openTempTf && !usePlaywright) await open(TEMP_TF_URL);

  if (!opts.skipPhone) {
    const apiKey = resolveOnlineSimApiKey() || cfg.onlinesimApiKey;
    if (!apiKey) fail("ONLINESIM_API_KEY missing in .env", 2);
    const os = new OnlineSimClient({ apiKey, lang: "en" });
    try {
      let tzid: number | undefined = opts.tzid
        ? Number(opts.tzid)
        : opts.freshPhone
          ? undefined
          : cfg.lastOnlineSim?.tzid;
      let number: string | undefined =
        opts.number || (opts.freshPhone ? undefined : cfg.lastOnlineSim?.number);
      let country: string | undefined = opts.freshPhone
        ? undefined
        : cfg.lastOnlineSim?.country;

      if (tzid && !opts.freshPhone && !opts.tzid) {
        try {
          const st = await os.getState({ tzid });
          if (!st.length) {
            log.warn(\`onlinesim tzid=\${tzid} gone — ordering fresh\`);
            tzid = undefined;
            number = undefined;
          }
        } catch {
          log.warn(\`onlinesim tzid=\${tzid} invalid — ordering fresh\`);
          tzid = undefined;
          number = undefined;
        }
      }

      if (!tzid || !number) {
        log.info(\`Ordering cheapest \${service} number…\`);
        const got = await os.getNumCheapest({
          service,
          number: true,
          onAttempt: (offer, i, err) => {
            if (!err && i === 0) log.info(\`  try country \${offer.country} @ \${offer.price}\`);
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
        log.info(\`Reusing onlinesim tzid=\${tzid} number=\${number}\`);
      }

      pack.phone = { number, tzid, country, service };
      if (opts.waitSms) {
        log.info(\`Waiting for SMS on \${number}…\`);
        const sms = await os.waitForSms({
          tzid: tzid!,
          timeoutMs,
          fullMessage: true,
          onTick: (st, attempt) => {
            if (attempt === 1 || attempt % 5 === 0) {
              log.dim(\`  sms poll #\${attempt} \${st?.response ?? "?"} msg=\${st?.msg ? "yes" : "no"}\`);
            }
          },
        });
        pack.phone.code = sms.code;
        pack.phone.fullMessage = sms.fullMessage;
        log.ok(\`SMS code \${sms.code}\`);
      } else {
        pack.next.push(\`aws-site-ship onlinesim wait --tzid \${tzid} --json\`);
      }
    } catch (e) {
      if (e instanceof OnlineSimError) fail(\`onlinesim \${e.code}\`, 3);
      throw e;
    }
  }

  if (!opts.skipMercury) {
    const token = resolveMercuryToken() || cfg.mercuryApiToken;
    if (!token) log.warn("MERCURY_API_TOKEN missing — skipping card");
    else {
      try {
        const mercury = new MercuryClient({ token });
        const policy = defaultDebitPolicy();
        const account = await mercury.pickDebitAccount(cfg.mercuryAccountId);
        const user = await mercury.pickUser(cfg.mercuryUserId);
        log.info("Issuing Mercury virtual debit ($1 / daily)…");
        const card = await mercury.createDebitCard({
          accountId: account.id,
          userId: user.id,
          amountCents: 100,
          interval: "daily",
          nickname: \`aws-signup-\${pack.accountName}\`.slice(0, 40),
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
        log.ok(\`Mercury card *\${card.lastFour} id=\${card.id}\`);
        pack.next.push("aws-site-ship mercury cancel-due");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(\`Mercury card failed: \${msg}\`);
        if (/ipNotWhitelisted|whitelist/i.test(msg) && !usePlaywright && !opts.noOpen) {
          await open("https://app.mercury.com/settings/tokens");
        }
      }
    }
  }

  if (usePlaywright) {
    if (!pack.email?.address) fail("Playwright signup needs an email", 2);
    log.info("Launching isolated Playwright Chromium…");
    const { result, context, page } = await runAwsSignupWithPlaywright({
      email: pack.email.address,
      accountName: pack.accountName,
      password: pack.password,
      phone: pack.phone?.number,
      headless: Boolean(opts.headless),
      holdForHuman: true,
    });
    pack.playwright = result;
    log.ok(\`Playwright filled: \${result.filled.join(", ") || "(none)"}\`);
    if (result.skipped.length) log.dim(\`Skipped: \${result.skipped.join(", ")}\`);
    log.info(\`URL: \${result.url}\`);
    log.dim(\`Profile: \${result.userDataDir}\`);

    if (pack.mercury) {
      const mercPage = await context.newPage();
      await mercPage.goto(MERCURY_CARDS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      log.ok("Opened Mercury cards inside Playwright");
    }

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
      if (opts.headless) await context.close();
      return;
    }

    if (!opts.headless) {
      log.blank();
      log.title("Signup pack — Playwright window open (not your main browser)");
      console.log(\`  Account name  \${pack.accountName}\`);
      console.log(\`  Password      \${pack.password}\`);
      console.log(\`  Email         \${pack.email.address}\`);
      if (pack.phone?.number) console.log(\`  Phone         \${pack.phone.number}\`);
      if (pack.mercury) console.log(\`  Card          Mercury *\${pack.mercury.lastFour}\`);
      log.warn("Solve CAPTCHA in the Chromium window. Ctrl+C when done.");
      await new Promise<void>(() => {
        void page;
      });
      return;
    }
    await context.close();
  } else if (!opts.noOpen) {
    await open(AWS_SIGNUP_URL);
    if (pack.mercury) await open(MERCURY_CARDS_URL);
  }

  const lastMail = loadConfig().lastTempMail;
  if (opts.waitEmail && lastMail?.token) {
    try {
      const tm = new TempMailClient();
      const msg = await tm.waitForMessage({
        token: lastMail.token,
        timeoutMs,
        match: /amazon|aws|verify|confirm/i,
      });
      const link = extractVerifyLink(msg);
      const code = extractEmailCode(msg);
      if (code) log.ok(\`Email code: \${code}\`);
      if (link) log.ok(\`Verify link: \${link}\`);
    } catch (e) {
      log.warn(\`Email wait: \${e instanceof Error ? e.message : String(e)}\`);
    }
  }

  pack.next.push(
    "After account exists: aws-site-ship auth -y && aws-site-ship headless --dir ./fixtures/site --words forest lamp --website",
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

  log.title("Signup pack");
  console.log(\`  Account name  \${pack.accountName}\`);
  console.log(\`  Password      \${pack.password}\`);
  if (pack.email) console.log(\`  Email         \${pack.email.address}\`);
  if (pack.phone?.number) console.log(\`  Phone         \${pack.phone.number}\`);
  if (pack.mercury) console.log(\`  Card          *\${pack.mercury.lastFour}\`);
  for (const n of pack.next) log.dim(\`  next: \${n}\`);
}
`;

writeFileSync("src/commands/auto-signup.ts", src);
console.log("wrote bytes", Buffer.byteLength(src));
