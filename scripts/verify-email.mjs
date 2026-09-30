import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const cfg = JSON.parse(
  readFileSync(join(homedir(), ".aws-site-ship", "config.json"), "utf8"),
);

const email = "ship287762a6@uberip.com";
const accountName = "site-ship-muodlscr";
const token = cfg.lastTempMail?.token;

console.log(
  JSON.stringify(
    {
      email,
      mailConfigured: cfg.lastTempMail?.address,
      hasToken: Boolean(token),
    },
    null,
    2,
  ),
);

const dir = join(
  homedir(),
  ".aws-site-ship",
  "pw-chromium",
  `verify-${Date.now().toString(36)}`,
);
mkdirSync(dir, { recursive: true });

const context = await chromium.launchPersistentContext(dir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(
  "https://signin.aws.amazon.com/signup?request_type=register",
  { waitUntil: "domcontentloaded", timeout: 60_000 },
);
await page.waitForTimeout(1500);

async function fill(sels, val) {
  for (const s of sels) {
    try {
      const loc = page.locator(s).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.fill(val);
        return s;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

const e = await fill(
  ["#emailAddress", "input[type=email]", "input[name=emailAddress]"],
  email,
);
const a = await fill(
  [
    "#accountName",
    "input[name=accountName]",
    "input[placeholder*=account i]",
  ],
  accountName,
);
console.log("filled", { e, a, url: page.url() });

let clicked = null;
for (const s of [
  'button:has-text("Verify email address")',
  'button:has-text("Verify email")',
  "button[type=submit]",
]) {
  try {
    const loc = page.locator(s).first();
    if ((await loc.count()) > 0 && (await loc.isVisible())) {
      await loc.click();
      clicked = s;
      break;
    }
  } catch {
    /* next */
  }
}
console.log("clicked", clicked);
await page.waitForTimeout(3500);
console.log("after-click url", page.url());
console.log("title", await page.title());

const body = await page.locator("body").innerText();
console.log("body-snip", body.slice(0, 1000).replace(/\n+/g, " | "));

if (token) {
  for (let i = 1; i <= 25; i++) {
    const res = await fetch("https://api.mail.tm/messages", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const j = await res.json();
    const members = Array.isArray(j) ? j : j["hydra:member"] || [];
    console.log("mail poll", i, "count", members.length, "status", res.status);
    if (members.length) {
      const id = members[0].id;
      const full = await fetch(`https://api.mail.tm/messages/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      const msg = await full.json();
      const text = [msg.subject, msg.intro, msg.text, ...(msg.html || [])]
        .filter(Boolean)
        .join("\n");
      const code = (text.match(/\b(\d{4,8})\b/) || [])[1] || null;
      const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      const link =
        urls.find((u) => /verify|confirm|amazon|aws/i.test(u)) || urls[0] || null;
      console.log(
        JSON.stringify(
          {
            subject: msg.subject,
            from: msg.from,
            code,
            link,
            intro: msg.intro,
          },
          null,
          2,
        ),
      );
      break;
    }
    await page.waitForTimeout(4000);
  }
} else {
  console.log("No mail.tm token — cannot poll inbox");
}

console.log("HOLDING browser open for human…");
await new Promise(() => {});
