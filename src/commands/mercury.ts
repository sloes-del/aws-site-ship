import open from "open";
import {
  DEFAULT_CARD_BUDGET_CENTS,
  MERCURY_CARDS_URL,
  MERCURY_TOKENS_URL,
  MercuryClient,
  MercuryError,
  defaultDebitPolicy,
  resolveMercuryToken,
  tomorrowLocalIso,
} from "../mercury/client.js";
import { loadConfig, saveConfig } from "../config.js";
import { fail, log, printJson } from "../ui.js";

function clientFromOpts(opts: { token?: string }): MercuryClient {
  const token =
    resolveMercuryToken(opts.token) || loadConfig().mercuryApiToken;
  if (!token) {
    fail(
      "Mercury API token required.\n" +
        "  1. Browser: aws-site-ship mercury auth   (opens token settings)\n" +
        "  2. Create a token, then:\n" +
        "       set MERCURY_API_TOKEN=secret-token:...\n" +
        "       OR  aws-site-ship mercury auth --token secret-token:...\n" +
        "  Docs: https://docs.mercury.com/docs/getting-started",
      2,
    );
  }
  return new MercuryClient({ token });
}

function printErr(err: unknown): never {
  if (err instanceof MercuryError) {
    fail(
      `mercury HTTP ${err.status}: ${err.message}${err.payload ? `\n  ${JSON.stringify(err.payload)}` : ""}`,
      3,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg, 3);
}

/** Open Mercury token page in a real browser; optionally save token. */
export async function mercuryAuthCommand(opts: {
  token?: string;
  noOpen?: boolean;
  json?: boolean;
}): Promise<void> {
  if (!opts.noOpen) {
    log.info(`Opening browser: ${MERCURY_TOKENS_URL}`);
    await open(MERCURY_TOKENS_URL);
    log.ok("Browser opened — create/copy an API token (read+write / cards scope).");
    log.dim("No headless automation: you paste the token yourself.");
  }

  const token = resolveMercuryToken(opts.token);
  if (!token) {
    if (opts.json) {
      printJson({
        ok: true,
        opened: !opts.noOpen,
        tokensUrl: MERCURY_TOKENS_URL,
        next: "Re-run with --token secret-token:... or set MERCURY_API_TOKEN",
      });
      return;
    }
    log.blank();
    log.info("After copying the token:");
    log.dim("  aws-site-ship mercury auth --token secret-token:YOUR_TOKEN");
    log.dim("  OR set MERCURY_API_TOKEN=secret-token:YOUR_TOKEN");
    return;
  }

  const client = new MercuryClient({ token });
  try {
    const accounts = await client.listAccounts();
    saveConfig({ mercuryApiToken: token });
    const payload = {
      ok: true,
      saved: true,
      accounts: accounts.length,
      tokensUrl: MERCURY_TOKENS_URL,
    };
    if (opts.json) {
      printJson(payload);
      return;
    }
    log.title("mercury auth");
    log.ok(`Token saved · ${accounts.length} account(s) visible`);
    log.dim("Prefer MERCURY_API_TOKEN env in CI; config is local convenience only.");
  } catch (e) {
    printErr(e);
  }
}

export async function mercuryAccountsCommand(opts: {
  token?: string;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  try {
    const accounts = await client.listAccounts();
    if (opts.json) {
      printJson(accounts.map((a) => ({
        id: a.id,
        name: a.name,
        nickname: a.nickname,
        status: a.status,
        kind: a.kind,
        availableBalance: a.availableBalance,
        dashboardLink: a.dashboardLink,
      })));
      return;
    }
    log.title("mercury accounts");
    for (const a of accounts) {
      console.log(
        `  ${a.id}  ${a.status}  bal=${a.availableBalance ?? "?"}  ${a.nickname || a.name}`,
      );
    }
    if (!accounts.length) log.warn("No accounts");
  } catch (e) {
    printErr(e);
  }
}

export async function mercuryUsersCommand(opts: {
  token?: string;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  try {
    const users = await client.listUsers();
    if (opts.json) {
      printJson(users);
      return;
    }
    log.title("mercury users (cardholders)");
    for (const u of users) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
      console.log(`  ${u.id}  ${name}  ${u.email ?? ""}`);
    }
    if (!users.length) {
      log.warn("No users — add a cardholder in the Mercury dashboard (browser).");
      log.dim("  aws-site-ship mercury open --cards");
    }
  } catch (e) {
    printErr(e);
  }
}

/**
 * Create virtual debit card:
 *  - budget $1 (100 cents) daily by default
 *  - schedule cancel at next local midnight ("expire next day")
 *  - optionally open cards dashboard in browser (no automation)
 */
export async function mercuryCardCommand(opts: {
  token?: string;
  account?: string;
  user?: string;
  nickname?: string;
  /** dollars, default 1 */
  budget?: string;
  interval?: string;
  /** hours until cancel; default = next local midnight */
  expireHours?: string;
  noCancelSchedule?: boolean;
  open?: boolean;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  const policy = defaultDebitPolicy();
  const budgetUsd = Number(opts.budget ?? "1");
  const amountCents = Math.max(0, Math.round(budgetUsd * 100));
  const interval = (opts.interval as "daily") || "daily";

  let cancelAt = policy.cancelAt;
  if (opts.expireHours) {
    const ms = Number(opts.expireHours) * 3600_000;
    cancelAt = new Date(Date.now() + ms).toISOString();
  }

  try {
    const account = await client.pickDebitAccount(
      opts.account || loadConfig().mercuryAccountId,
    );
    const user = await client.pickUser(
      opts.user || loadConfig().mercuryUserId,
    );

    log.info(
      `Issuing virtual debit · account ${account.id} · user ${user.id} · $${budgetUsd} / ${interval}`,
    );
    log.dim(
      `Network exp is MM/YYYY; policy cancelAt=${cancelAt} (expire next day via cancel)`,
    );

    const card = await client.createDebitCard({
      accountId: account.id,
      userId: user.id,
      nickname: opts.nickname,
      amountCents: amountCents || DEFAULT_CARD_BUDGET_CENTS,
      interval,
    });

    if (!opts.noCancelSchedule) {
      saveConfig({
        mercuryAccountId: account.id,
        mercuryUserId: user.id,
        lastMercuryCard: {
          id: card.id,
          lastFour: card.lastFour,
          accountId: card.accountId,
          userId: card.userId,
          nickname: card.nickname ?? undefined,
          amountCents,
          interval,
          cancelAt,
          status: card.status,
          at: new Date().toISOString(),
        },
      });
    } else {
      saveConfig({
        mercuryAccountId: account.id,
        mercuryUserId: user.id,
        lastMercuryCard: {
          id: card.id,
          lastFour: card.lastFour,
          accountId: card.accountId,
          userId: card.userId,
          nickname: card.nickname ?? undefined,
          amountCents,
          interval,
          status: card.status,
          at: new Date().toISOString(),
        },
      });
    }

    const payload = {
      ok: true,
      card: {
        id: card.id,
        lastFour: card.lastFour,
        nameOnCard: card.nameOnCard,
        nickname: card.nickname,
        status: card.status,
        kind: card.kind,
        type: card.type,
        spendLimit: card.spendLimit,
        expiration: card.expiration,
        isAgentCard: card.isAgentCard,
      },
      policy: {
        budgetUsd,
        amountCents,
        interval,
        cancelAt: opts.noCancelSchedule ? null : cancelAt,
        note: policy.note,
      },
      browser: {
        cards: MERCURY_CARDS_URL,
        account: account.dashboardLink,
      },
    };

    if (opts.open !== false) {
      log.info(`Opening cards dashboard in browser: ${MERCURY_CARDS_URL}`);
      await open(MERCURY_CARDS_URL);
    }

    if (opts.json) {
      printJson(payload);
      return;
    }

    log.title("mercury debit card");
    log.ok(`id        ${card.id}`);
    log.ok(`last4     ${card.lastFour}`);
    log.ok(`status    ${card.status}`);
    log.info(
      `limit     $${(amountCents / 100).toFixed(2)} / ${interval}`,
    );
    if (card.expiration) {
      log.info(
        `PAN exp   ${card.expiration.month}/${card.expiration.year} (network; not “tomorrow”)`,
      );
    }
    if (!opts.noCancelSchedule) {
      log.ok(`cancelAt  ${cancelAt}`);
      log.dim("  Run later: aws-site-ship mercury cancel-due");
      log.dim("  Or now:    aws-site-ship mercury cancel --id " + card.id);
    }
    log.dim("Full PAN: dashboard browser (or mercury reveal if agent card)");
  } catch (e) {
    printErr(e);
  }
}

export async function mercuryListCommand(opts: {
  token?: string;
  account?: string;
  kind?: string;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  try {
    const cards = await client.listCards({
      accountId: opts.account,
      kind: opts.kind || "debit",
    });
    if (opts.json) {
      printJson(cards);
      return;
    }
    log.title("mercury cards");
    for (const c of cards) {
      const lim = c.spendLimit
        ? `$${(c.spendLimit.amountCents / 100).toFixed(2)}/${c.spendLimit.interval}`
        : "no-limit";
      console.log(
        `  ${c.id}  *${c.lastFour}  ${c.status}  ${c.kind}/${c.type}  ${lim}  ${c.nickname ?? ""}`,
      );
    }
    if (!cards.length) log.warn("No cards");
  } catch (e) {
    printErr(e);
  }
}

export async function mercuryCancelCommand(opts: {
  token?: string;
  id?: string;
  json?: boolean;
}): Promise<void> {
  const id = opts.id || loadConfig().lastMercuryCard?.id;
  if (!id) fail("Need --id or a prior mercury card in config", 2);
  const client = clientFromOpts(opts);
  try {
    const card = await client.cancelCard(id);
    const prev = loadConfig().lastMercuryCard;
    if (prev?.id === id) {
      saveConfig({
        lastMercuryCard: { ...prev, status: card.status, cancelAt: undefined },
      });
    }
    if (opts.json) {
      printJson({ ok: true, card });
      return;
    }
    log.ok(`Cancelled card ${card.id} (*${card.lastFour}) status=${card.status}`);
  } catch (e) {
    printErr(e);
  }
}

/** Cancel last card if cancelAt <= now (expire-next-day worker). */
export async function mercuryCancelDueCommand(opts: {
  token?: string;
  json?: boolean;
}): Promise<void> {
  const last = loadConfig().lastMercuryCard;
  if (!last?.id) {
    fail("No lastMercuryCard in config — nothing to expire", 1);
  }
  if (!last.cancelAt) {
    fail("lastMercuryCard has no cancelAt schedule", 1);
  }
  const due = new Date(last.cancelAt).getTime() <= Date.now();
  if (!due) {
    const payload = {
      ok: true,
      cancelled: false,
      cardId: last.id,
      cancelAt: last.cancelAt,
      reason: "not_due_yet",
    };
    if (opts.json) {
      printJson(payload);
      return;
    }
    log.info(`Not due yet — cancelAt ${last.cancelAt}`);
    return;
  }

  const client = clientFromOpts(opts);
  try {
    const card = await client.cancelCard(last.id);
    saveConfig({
      lastMercuryCard: { ...last, status: card.status, cancelAt: undefined },
    });
    if (opts.json) {
      printJson({ ok: true, cancelled: true, card });
      return;
    }
    log.ok(`Expired/cancelled due card ${card.id} (*${card.lastFour})`);
  } catch (e) {
    printErr(e);
  }
}

export async function mercuryOpenCommand(opts: {
  cards?: boolean;
  tokens?: boolean;
  account?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  if (opts.tokens) {
    log.info(MERCURY_TOKENS_URL);
    await open(MERCURY_TOKENS_URL);
    log.ok("Opened token settings in browser");
    return;
  }
  if (opts.account && cfg.mercuryAccountId) {
    // dashboard link may not be cached — open generic accounts
    const url = "https://app.mercury.com/accounts";
    await open(url);
    log.ok(`Opened ${url}`);
    return;
  }
  await open(MERCURY_CARDS_URL);
  log.ok(`Opened ${MERCURY_CARDS_URL}`);
  log.dim("View PAN/CVC in the browser card detail — no scraper automation.");
}

export async function mercuryRevealCommand(opts: {
  token?: string;
  id?: string;
  json?: boolean;
}): Promise<void> {
  const id = opts.id || loadConfig().lastMercuryCard?.id;
  if (!id) fail("Need --id", 2);
  const client = clientFromOpts(opts);
  try {
    const secrets = await client.revealCard(id);
    if (opts.json) {
      printJson({ ok: true, cardId: id, ...secrets });
      return;
    }
    log.title("mercury reveal (agent cards only)");
    log.ok(`PAN  ${secrets.cardNumber}`);
    log.ok(`CVC  ${secrets.cvc}`);
    log.ok(
      `EXP  ${secrets.expiration.month}/${secrets.expiration.year}`,
    );
  } catch (e) {
    log.warn(
      "Reveal failed (only agent cards support vault PAN). Use browser card UI instead:",
    );
    log.dim("  aws-site-ship mercury open --cards");
    printErr(e);
  }
}

export async function mercuryPolicyCommand(opts: { json?: boolean }): Promise<void> {
  const p = defaultDebitPolicy();
  if (opts.json) {
    printJson(p);
    return;
  }
  log.title("mercury default debit policy");
  log.ok(`Budget     $${p.budgetUsd} (${p.amountCents} cents) / ${p.interval}`);
  log.ok(`Cancel at  ${p.cancelAt} (next local midnight)`);
  log.dim(p.note);
  log.blank();
  log.info("Create:");
  log.dim("  aws-site-ship mercury card");
  log.dim("  aws-site-ship mercury card --budget 1 --open");
  log.info("Expire:");
  log.dim("  aws-site-ship mercury cancel-due");
}
