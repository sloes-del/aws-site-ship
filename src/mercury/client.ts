/**
 * Mercury Bank API client (Cards + Accounts + Users).
 * Docs: https://docs.mercury.com/
 *
 * Auth: Bearer token from https://app.mercury.com/settings/tokens
 * (open in a real browser — no headless automation).
 *
 * Base: https://api.mercury.com/api/v1
 * Vault (agent PAN reveal only): https://vault-api.mercury.com/api/v1
 */

const DEFAULT_BASE = "https://api.mercury.com/api/v1";
const DEFAULT_VAULT = "https://vault-api.mercury.com/api/v1";
const TOKENS_URL = "https://app.mercury.com/settings/tokens";
const CARDS_DASH_URL = "https://app.mercury.com/cards";

export const MERCURY_TOKENS_URL = TOKENS_URL;
export const MERCURY_CARDS_URL = CARDS_DASH_URL;

/** Default disposable debit policy: $1 / day, cancel the next calendar day. */
export const DEFAULT_CARD_BUDGET_CENTS = 100;
export const DEFAULT_SPEND_INTERVAL = "daily" as const;

export type SpendLimitInterval = "daily" | "weekly" | "monthly" | "yearly";

export type MercuryCard = {
  id: string;
  accountId: string;
  userId: string;
  lastFour: string;
  nameOnCard: string;
  nickname?: string | null;
  status: string;
  type: string;
  kind: string;
  isAgentCard?: boolean;
  expiration?: { month: number; year: number };
  spendLimit?: {
    amountCents: number;
    interval: SpendLimitInterval;
    atmAmountCents?: number | null;
  } | null;
  spendLimitType?: string;
  budgets?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
};

export type MercuryAccount = {
  id: string;
  name: string;
  nickname?: string | null;
  status: string;
  type: string;
  kind?: string;
  availableBalance?: number;
  currentBalance?: number;
  dashboardLink?: string;
  raw: Record<string, unknown>;
};

export type MercuryUser = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  raw: Record<string, unknown>;
};

export class MercuryError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "MercuryError";
    this.status = status;
    this.payload = payload;
  }
}

export type MercuryClientOptions = {
  token: string;
  baseUrl?: string;
  vaultUrl?: string;
  fetchImpl?: typeof fetch;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function mapCard(raw: Record<string, unknown>): MercuryCard {
  const exp = asRecord(raw.expiration);
  const lim = asRecord(raw.spendLimit);
  return {
    id: String(raw.id ?? ""),
    accountId: String(raw.accountId ?? ""),
    userId: String(raw.userId ?? ""),
    lastFour: String(raw.lastFour ?? ""),
    nameOnCard: String(raw.nameOnCard ?? ""),
    nickname: (raw.nickname as string | null | undefined) ?? null,
    status: String(raw.status ?? ""),
    type: String(raw.type ?? ""),
    kind: String(raw.kind ?? ""),
    isAgentCard: Boolean(raw.isAgentCard),
    expiration:
      exp.month !== undefined
        ? { month: Number(exp.month), year: Number(exp.year) }
        : undefined,
    spendLimit:
      lim.amountCents !== undefined
        ? {
            amountCents: Number(lim.amountCents),
            interval: String(lim.interval ?? "daily") as SpendLimitInterval,
            atmAmountCents:
              lim.atmAmountCents === null || lim.atmAmountCents === undefined
                ? null
                : Number(lim.atmAmountCents),
          }
        : null,
    spendLimitType: str(raw.spendLimitType),
    budgets: Array.isArray(raw.budgets) ? raw.budgets : [],
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    raw,
  };
}

function mapAccount(raw: Record<string, unknown>): MercuryAccount {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    nickname: (raw.nickname as string | null | undefined) ?? null,
    status: String(raw.status ?? ""),
    type: String(raw.type ?? ""),
    kind: str(raw.kind),
    availableBalance:
      raw.availableBalance !== undefined
        ? Number(raw.availableBalance)
        : undefined,
    currentBalance:
      raw.currentBalance !== undefined ? Number(raw.currentBalance) : undefined,
    dashboardLink: str(raw.dashboardLink),
    raw,
  };
}

function mapUser(raw: Record<string, unknown>): MercuryUser {
  return {
    id: String(raw.id ?? raw.userId ?? ""),
    firstName: str(raw.firstName ?? raw.firstname),
    lastName: str(raw.lastName ?? raw.lastname),
    email: str(raw.email),
    raw,
  };
}

/** Start of tomorrow (local) as ISO — used as cancel-by policy. */
export function tomorrowLocalIso(from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Human label for the $1 / expire-next-day policy. */
export function defaultDebitPolicy() {
  return {
    budgetUsd: 1,
    amountCents: DEFAULT_CARD_BUDGET_CENTS,
    interval: DEFAULT_SPEND_INTERVAL,
    cancelAt: tomorrowLocalIso(),
    note:
      "Mercury network expiry is MM/YYYY only. We set spendLimit $1/daily and schedule cancel for next local midnight.",
  };
}

export class MercuryClient {
  readonly token: string;
  readonly baseUrl: string;
  readonly vaultUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MercuryClientOptions) {
    const t = opts.token?.trim();
    if (!t) throw new MercuryError("Missing Mercury API token", 0);
    // Accept raw token or already-prefixed secret-token:…
    this.token = t.startsWith("secret-token:") ? t : t;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.vaultUrl = (opts.vaultUrl ?? DEFAULT_VAULT).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private authHeader(): string {
    // Docs support Bearer and basic-auth username=token password=""
    return `Bearer ${this.token}`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      base?: "api" | "vault";
    },
  ): Promise<T> {
    const root = opts?.base === "vault" ? this.vaultUrl : this.baseUrl;
    const url = new URL(
      path.startsWith("http") ? path : `${root}${path.startsWith("/") ? path : `/${path}`}`,
    );
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        Authorization: this.authHeader(),
        ...(opts?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const msg =
        typeof data === "object" && data && "message" in data
          ? String((data as { message: unknown }).message)
          : typeof data === "string"
            ? data.slice(0, 300)
            : `HTTP ${res.status}`;
      throw new MercuryError(`mercury ${method} ${path}: ${msg}`, res.status, data);
    }

    return data as T;
  }

  async listAccounts(): Promise<MercuryAccount[]> {
    const data = asRecord(await this.request("GET", "/accounts", { query: { limit: 1000 } }));
    const list = Array.isArray(data.accounts)
      ? data.accounts
      : Array.isArray(data)
        ? data
        : [];
    return list.map((a) => mapAccount(asRecord(a)));
  }

  /** Prefer active mercury checking-like accounts for debit funding. */
  async pickDebitAccount(accountId?: string): Promise<MercuryAccount> {
    const accounts = await this.listAccounts();
    if (accountId) {
      const hit = accounts.find((a) => a.id === accountId);
      if (!hit) throw new MercuryError(`Account not found: ${accountId}`, 404);
      return hit;
    }
    const active = accounts.filter(
      (a) =>
        a.status === "active" &&
        (a.type === "mercury" || !a.type || a.type === "checking"),
    );
    const checking = active.find((a) =>
      /check/i.test(`${a.kind ?? ""} ${a.name} ${a.nickname ?? ""}`),
    );
    const pick = checking ?? active[0] ?? accounts[0];
    if (!pick) {
      throw new MercuryError("No Mercury accounts available for debit cards", 400);
    }
    return pick;
  }

  async listUsers(): Promise<MercuryUser[]> {
    const data = await this.request<unknown>("GET", "/users");
    const raw = asRecord(data);
    const list = Array.isArray(data)
      ? data
      : Array.isArray(raw.users)
        ? raw.users
        : Array.isArray(raw.data)
          ? raw.data
          : [];
    return list.map((u) => mapUser(asRecord(u)));
  }

  async pickUser(userId?: string): Promise<MercuryUser> {
    const users = await this.listUsers();
    if (userId) {
      const hit = users.find((u) => u.id === userId);
      if (!hit) throw new MercuryError(`User not found: ${userId}`, 404);
      return hit;
    }
    if (!users.length) {
      throw new MercuryError(
        "No users on this org. Add a cardholder in the Mercury dashboard (browser), then retry.",
        400,
      );
    }
    return users[0]!;
  }

  async listCards(opts?: {
    accountId?: string;
    kind?: string;
    status?: string;
    limit?: number;
  }): Promise<MercuryCard[]> {
    const data = asRecord(
      await this.request("GET", "/cards", {
        query: {
          accountId: opts?.accountId,
          kind: opts?.kind,
          status: opts?.status,
          limit: opts?.limit ?? 500,
        },
      }),
    );
    const list = Array.isArray(data.cards) ? data.cards : [];
    return list.map((c) => mapCard(asRecord(c)));
  }

  async getCard(cardId: string): Promise<MercuryCard> {
    const raw = asRecord(await this.request("GET", `/cards/${cardId}`));
    return mapCard(raw);
  }

  /**
   * Issue virtual debit card with $1 daily spend limit by default.
   * Network PAN expiry is always MM/YYYY — use scheduleCancelAt for "expires next day".
   */
  async createDebitCard(opts: {
    userId: string;
    accountId: string;
    nickname?: string;
    amountCents?: number;
    interval?: SpendLimitInterval;
  }): Promise<MercuryCard> {
    const amountCents = opts.amountCents ?? DEFAULT_CARD_BUDGET_CENTS;
    const interval = opts.interval ?? DEFAULT_SPEND_INTERVAL;
    const body = {
      userId: opts.userId,
      accountId: opts.accountId,
      kind: "debit",
      type: "virtual",
      nickname: opts.nickname ?? `ship-$1-${new Date().toISOString().slice(0, 10)}`,
      spendLimit: {
        amountCents,
        interval,
      },
    };
    const raw = asRecord(await this.request("POST", "/cards", { body }));
    return mapCard(raw);
  }

  async updateCard(
    cardId: string,
    opts: {
      nickname?: string | null;
      spendLimit?: {
        amountCents: number;
        interval: SpendLimitInterval;
        atmAmountCents?: number | null;
      } | null;
    },
  ): Promise<MercuryCard> {
    const body: Record<string, unknown> = {
      // API requires nickname field present on update schema
      nickname: opts.nickname === undefined ? undefined : opts.nickname,
    };
    if (opts.spendLimit !== undefined) body.spendLimit = opts.spendLimit;
    // If nickname omitted, send empty keep-current workaround: fetch then echo
    if (body.nickname === undefined) {
      const cur = await this.getCard(cardId);
      body.nickname = cur.nickname ?? cur.nameOnCard ?? "";
    }
    const raw = asRecord(
      await this.request("POST", `/cards/${cardId}`, { body }),
    );
    return mapCard(raw);
  }

  async cancelCard(cardId: string): Promise<MercuryCard> {
    const raw = asRecord(
      await this.request("POST", `/cards/${cardId}/cancel`, { body: {} }),
    );
    return mapCard(raw);
  }

  async freezeCard(cardId: string): Promise<MercuryCard> {
    const raw = asRecord(
      await this.request("POST", `/cards/${cardId}/freeze`, { body: {} }),
    );
    return mapCard(raw);
  }

  async unfreezeCard(cardId: string): Promise<MercuryCard> {
    const raw = asRecord(
      await this.request("POST", `/cards/${cardId}/unfreeze`, { body: {} }),
    );
    return mapCard(raw);
  }

  /** Agent cards only — full PAN/CVC from vault host. */
  async revealCard(cardId: string): Promise<{
    cardNumber: string;
    cvc: string;
    expiration: { month: number; year: number };
  }> {
    const raw = asRecord(
      await this.request("GET", `/cards/${cardId}/reveal`, { base: "vault" }),
    );
    const exp = asRecord(raw.expiration);
    return {
      cardNumber: String(raw.cardNumber ?? ""),
      cvc: String(raw.cvc ?? ""),
      expiration: { month: Number(exp.month), year: Number(exp.year) },
    };
  }
}

export function resolveMercuryToken(explicit?: string): string | undefined {
  const t =
    explicit?.trim() ||
    process.env.MERCURY_API_TOKEN?.trim() ||
    process.env.MERCURY_TOKEN?.trim() ||
    process.env.AWS_SITE_SHIP_MERCURY_TOKEN?.trim() ||
    undefined;
  return t || undefined;
}
