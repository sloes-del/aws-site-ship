/**
 * onlinesim.io HTTP client (API key auth).
 * Docs: https://onlinesim.io/docs/api
 *
 * Base: GET https://onlinesim.io/api/<method>.php?apikey=...
 * Errors often still HTTP 200 with { response: "ERROR_CODE" }.
 */

const DEFAULT_BASE = "https://onlinesim.io/api";

export type OnlineSimErrorCode =
  | "ERROR_WRONG_KEY"
  | "ERROR_NO_KEY"
  | "ERROR_NO_SERVICE"
  | "WARNING_LOW_BALANCE"
  | "NO_NUMBER"
  | "ACCOUNT_BLOCKED"
  | "API_ACCESS_DISABLED"
  | "API_ACCESS_IP"
  | "UNDEFINED_COUNTRY"
  | "UNDEFINED_DAYS"
  | "INTERVAL_CONCURRENT_REQUESTS_ERROR"
  | "REQUEST_NOT_FOUND"
  | "TRY_AGAIN_LATER"
  | string;

export class OnlineSimError extends Error {
  readonly code: OnlineSimErrorCode;
  readonly payload: unknown;

  constructor(code: OnlineSimErrorCode, payload?: unknown) {
    super(`onlinesim: ${code}`);
    this.name = "OnlineSimError";
    this.code = code;
    this.payload = payload;
  }
}

export type OnlineSimClientOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Default response language for string fields */
  lang?: "en" | "ru" | "de" | "fr" | "zh";
  fetchImpl?: typeof fetch;
};

export type Balance = {
  balance: number;
  zbalance: number;
  income?: number;
  incomeUsd?: number;
  raw: Record<string, unknown>;
};

export type GetNumResult = {
  tzid: number;
  number?: string;
  country?: number | string;
  service?: string;
  sum?: number;
  time?: number;
  raw: Record<string, unknown>;
};

export type OperationState = {
  tzid: number;
  response: string;
  number?: string;
  country?: number | string;
  service?: string;
  sum?: number;
  time?: number;
  /** Code or full SMS depending on message_to_code */
  msg?: string | null;
  form?: string;
  msgList?: unknown;
  raw: Record<string, unknown>;
};

export type WaitForSmsResult = {
  tzid: number;
  number?: string;
  code: string;
  fullMessage?: string;
  state: OperationState;
  attempts: number;
  elapsedMs: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return fallback;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/** Extract digits that look like an OTP (4–8). Prefer longer matches near end. */
export function extractSmsCode(text: string): string | null {
  const cleaned = text.replace(/[^\d\s\-.:]/g, " ");
  const matches = cleaned.match(/\b(\d{4,8})\b/g);
  if (!matches?.length) return null;
  return matches[matches.length - 1] ?? null;
}

export type TariffOffer = {
  country: string;
  countryName?: string;
  service: string;
  price: number;
  count: number;
  enabled: boolean;
  raw: Record<string, unknown>;
};

const PRICE_KEYS = [
  "price",
  "cost",
  "sum",
  "rate",
  "tariff",
  "locale_price",
  "price_usd",
  "cost_usd",
] as const;

const COUNT_KEYS = ["count", "qty", "quantity", "numbers", "available"] as const;

function pickPrice(obj: Record<string, unknown>): number | null {
  for (const k of PRICE_KEYS) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
      const n = num(obj[k], NaN);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function pickCount(obj: Record<string, unknown>): number {
  for (const k of COUNT_KEYS) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
      const n = num(obj[k], NaN);
      if (Number.isFinite(n)) return n;
    }
  }
  // enable-only rows: treat unknown stock as 1 if enabled
  return 0;
}

function isEnabled(obj: Record<string, unknown>): boolean {
  if (obj.enable === false || obj.enabled === false || obj.available === false) {
    return false;
  }
  if (obj.enable === 0 || obj.enabled === 0) return false;
  if (obj.enable === "0" || obj.enabled === "0") return false;
  return true;
}

function serviceMatches(candidate: string, wanted: string): boolean {
  const a = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const b = wanted.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Walk arbitrary getTariffs / tariffsRent JSON and collect priced offers.
 * onlinesim shapes vary (country→service map, arrays, nested `services`).
 */
export function parseTariffOffers(
  data: unknown,
  opts?: { service?: string },
): TariffOffer[] {
  const wanted = opts?.service?.trim();
  const out: TariffOffer[] = [];
  const seen = new Set<string>();

  const push = (offer: TariffOffer) => {
    if (wanted && !serviceMatches(offer.service, wanted)) return;
    if (!offer.enabled) return;
    if (offer.count <= 0 && offer.price <= 0) return;
    // require some stock when count is known >0 path; allow count 0 only if price set & enable (stock unknown)
    const key = `${offer.country}|${offer.service}|${offer.price}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(offer);
  };

  const visit = (
    node: unknown,
    ctx: { country?: string; countryName?: string; service?: string },
  ): void => {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, ctx);
      return;
    }

    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // Skip pure error wrappers
    if (
      typeof obj.response === "string" &&
      /[A-Z_]/.test(obj.response) &&
      obj.response !== "1" &&
      Object.keys(obj).length <= 2
    ) {
      return;
    }

    let country = ctx.country;
    let countryName = ctx.countryName;
    let service = ctx.service;

    if (obj.country !== undefined && obj.country !== null) {
      country = String(obj.country);
    } else if (obj.country_code !== undefined) {
      country = String(obj.country_code);
    } else if (obj.code !== undefined && typeof obj.code !== "object") {
      // careful: service codes exist too — only if looks like country (digits / short)
      const c = String(obj.code);
      if (/^\d{1,4}$/.test(c)) country = c;
    }

    if (typeof obj.name === "string" && country && !countryName) {
      countryName = obj.name;
    }
    if (typeof obj.country_name === "string") countryName = obj.country_name;

    if (typeof obj.service === "string") service = obj.service;
    else if (typeof obj.slug === "string") service = obj.slug;

    const price = pickPrice(obj);
    const count = pickCount(obj);
    const enabled = isEnabled(obj);

    // Leaf: has price and we know country + service
    if (price !== null && country && service) {
      push({
        country,
        countryName,
        service,
        price,
        count: count > 0 ? count : enabled ? 1 : 0,
        enabled,
        raw: obj,
      });
    }

    // country-keyed map: { "7": { telegram: { cost, count }, name: "Russia" }, response: 1 }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "response" || k === "raw") continue;

      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const child = v as Record<string, unknown>;
        // key is country code
        if (/^\d{1,4}$/.test(k)) {
          const cName =
            typeof child.name === "string" ? child.name : countryName;
          // services nested under country
          for (const [sk, sv] of Object.entries(child)) {
            if (sk === "name" || sk === "code" || sk === "pos") continue;
            if (sv !== null && typeof sv === "object") {
              visit(sv, {
                country: k,
                countryName: cName,
                service: sk,
              });
            }
          }
          visit(child, { country: k, countryName: cName, service });
          continue;
        }

        // key is service name under a country ctx
        if (country && !/^\d+$/.test(k) && k !== "services" && k !== "days") {
          const p = pickPrice(child);
          if (p !== null) {
            visit(child, { country, countryName, service: k });
            continue;
          }
        }
      }

      visit(v, { country, countryName, service });
    }
  };

  visit(data, {});
  return out.sort((a, b) => a.price - b.price || b.count - a.count);
}

/** Cheapest in-stock offer for a service (count>0 preferred). */
export function findCheapestOffer(
  data: unknown,
  service: string,
  opts?: { requireStock?: boolean },
): TariffOffer | null {
  const requireStock = opts?.requireStock !== false;
  const offers = parseTariffOffers(data, { service }).filter((o) =>
    requireStock ? o.count > 0 : true,
  );
  if (!offers.length) {
    // fallback: ignore stock
    const any = parseTariffOffers(data, { service });
    return any[0] ?? null;
  }
  return offers[0] ?? null;
}

export function listCountriesByPrice(
  data: unknown,
  service: string,
): TariffOffer[] {
  const offers = parseTariffOffers(data, { service }).filter((o) => o.count > 0);
  const byCountry = new Map<string, TariffOffer>();
  for (const o of offers) {
    const prev = byCountry.get(o.country);
    if (!prev || o.price < prev.price) byCountry.set(o.country, o);
  }
  return [...byCountry.values()].sort((a, b) => a.price - b.price);
}

export class OnlineSimClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly lang: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OnlineSimClientOptions) {
    if (!opts.apiKey?.trim()) {
      throw new OnlineSimError("ERROR_NO_KEY");
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.lang = opts.lang ?? "en";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private buildUrl(
    method: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): string {
    const path = method.endsWith(".php") ? method : `${method}.php`;
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set("apikey", this.apiKey);
    if (!("lang" in params) || params.lang === undefined) {
      url.searchParams.set("lang", this.lang);
    }
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /**
   * Low-level GET. Throws OnlineSimError when `response` is a known error string.
   * Success payloads often use response: "1" | 1.
   */
  async request<T = unknown>(
    method: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(method, params);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new OnlineSimError("TRY_AGAIN_LATER", {
        httpStatus: res.status,
        body: text.slice(0, 500),
      });
    }

    if (!res.ok) {
      throw new OnlineSimError("TRY_AGAIN_LATER", {
        httpStatus: res.status,
        body: data,
      });
    }

    // Error shape: { response: "ERROR_CODE" }
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const resp = (data as { response?: unknown }).response;
      if (typeof resp === "string" && resp !== "1" && /[A-Z_]/.test(resp)) {
        throw new OnlineSimError(resp, data);
      }
    }

    // getState sometimes returns NO_OPERATIONS style string-only errors in array form — leave to caller
    return data as T;
  }

  async getBalance(opts?: { income?: boolean }): Promise<Balance> {
    const raw = asRecord(
      await this.request("getBalance", {
        income: opts?.income ? true : undefined,
      }),
    );
    return {
      balance: num(raw.balance),
      zbalance: num(raw.zbalance),
      income: raw.income !== undefined ? num(raw.income) : undefined,
      incomeUsd: raw.income_usd !== undefined ? num(raw.income_usd) : undefined,
      raw,
    };
  }

  async getTariffs(opts?: {
    country?: string | number;
    filterCountry?: string | number;
    filterService?: string;
    page?: number;
    count?: number;
  }): Promise<unknown> {
    return this.request("getTariffs", {
      country: opts?.country,
      filter_country: opts?.filterCountry ?? opts?.country,
      filter_service: opts?.filterService,
      page: opts?.page,
      count: opts?.count,
    });
  }

  /** Rank countries for a service cheapest-first (in stock). */
  async cheapestCountries(service: string): Promise<TariffOffer[]> {
    const data = await this.getTariffs({ filterService: service });
    let list = listCountriesByPrice(data, service);
    if (!list.length) {
      // unfiltered dump — parser still slices by service
      const all = await this.getTariffs({});
      list = listCountriesByPrice(all, service);
    }
    return list;
  }

  async findCheapestCountry(service: string): Promise<TariffOffer> {
    const list = await this.cheapestCountries(service);
    const best = list[0];
    if (!best) {
      throw new OnlineSimError("NO_NUMBER", {
        reason: `no tariffs with stock for service=${service}`,
      });
    }
    return best;
  }

  /**
   * Order a number trying cheapest countries first until one succeeds.
   */
  async getNumCheapest(opts: {
    service: string;
    /** Try at most N countries (default 8) */
    maxAttempts?: number;
    number?: boolean;
    devId?: number;
    onAttempt?: (offer: TariffOffer, index: number, err?: unknown) => void;
  }): Promise<GetNumResult & { offer: TariffOffer; attempts: number }> {
    const ranked = await this.cheapestCountries(opts.service);
    if (!ranked.length) {
      throw new OnlineSimError("NO_NUMBER", {
        reason: `no countries for service=${opts.service}`,
      });
    }
    const max = Math.min(opts.maxAttempts ?? 8, ranked.length);
    let lastErr: unknown;
    for (let i = 0; i < max; i++) {
      const offer = ranked[i]!;
      try {
        opts.onAttempt?.(offer, i);
        const got = await this.getNum({
          service: opts.service,
          country: offer.country,
          number: opts.number,
          devId: opts.devId,
        });
        return { ...got, offer, attempts: i + 1 };
      } catch (e) {
        lastErr = e;
        opts.onAttempt?.(offer, i, e);
        if (e instanceof OnlineSimError) {
          if (
            e.code === "NO_NUMBER" ||
            e.code === "TRY_AGAIN_LATER" ||
            e.code === "UNDEFINED_COUNTRY"
          ) {
            continue;
          }
          // balance / auth — don't keep burning
          if (
            e.code === "WARNING_LOW_BALANCE" ||
            e.code === "ERROR_WRONG_KEY" ||
            e.code === "ACCOUNT_BLOCKED"
          ) {
            throw e;
          }
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new OnlineSimError("NO_NUMBER", { lastErr, tried: max });
  }

  /**
   * Order a single-service number.
   * Pass number=true (default) so the phone is in the response.
   */
  async getNum(opts: {
    service: string;
    country: string | number;
    number?: boolean;
    devId?: number;
  }): Promise<GetNumResult> {
    const raw = asRecord(
      await this.request("getNum", {
        service: opts.service,
        country: opts.country,
        number: opts.number !== false ? true : undefined,
        dev_id: opts.devId,
      }),
    );

    const tzid = num(raw.tzid, NaN);
    if (!Number.isFinite(tzid)) {
      throw new OnlineSimError("TRY_AGAIN_LATER", raw);
    }

    return {
      tzid,
      number: str(raw.number),
      country: (raw.country as number | string | undefined) ?? opts.country,
      service: str(raw.service) ?? opts.service,
      sum: raw.sum !== undefined ? num(raw.sum) : undefined,
      time: raw.time !== undefined ? num(raw.time) : undefined,
      raw,
    };
  }

  async getState(opts?: {
    tzid?: number | string;
    /** 0 = full SMS, 1 = code only (API default 1) */
    messageToCode?: 0 | 1;
    msgList?: 0 | 1;
    clean?: 0 | 1;
    orderby?: "asc" | "desc";
  }): Promise<OperationState[]> {
    const data = await this.request<unknown>("getState", {
      tzid: opts?.tzid,
      message_to_code: opts?.messageToCode ?? 1,
      msg_list: opts?.msgList,
      clean: opts?.clean,
      orderby: opts?.orderby ?? "desc",
    });

    // Success: array of ops, or { response: "1", ... } edge cases
    if (Array.isArray(data)) {
      return data.map((item) => {
        const raw = asRecord(item);
        return {
          tzid: num(raw.tzid),
          response: str(raw.response) ?? "",
          number: str(raw.number),
          country: raw.country as number | string | undefined,
          service: str(raw.service),
          sum: raw.sum !== undefined ? num(raw.sum) : undefined,
          time: raw.time !== undefined ? num(raw.time) : undefined,
          msg:
            raw.msg === null || raw.msg === undefined ? null : str(raw.msg) ?? null,
          form: str(raw.form),
          msgList: raw.msg_list ?? raw.msgList,
          raw,
        } satisfies OperationState;
      });
    }

    const raw = asRecord(data);
    if (typeof raw.response === "string" && /[A-Z_]/.test(raw.response) && raw.response !== "1") {
      // e.g. NO_OPERATIONS
      if (raw.response === "NO_OPERATIONS" || raw.response === "ERROR_NO_OPERATIONS") {
        return [];
      }
      throw new OnlineSimError(raw.response, data);
    }

    // Single wrapped object
    if (raw.tzid !== undefined) {
      return [
        {
          tzid: num(raw.tzid),
          response: str(raw.response) ?? "",
          number: str(raw.number),
          country: raw.country as number | string | undefined,
          service: str(raw.service),
          sum: raw.sum !== undefined ? num(raw.sum) : undefined,
          time: raw.time !== undefined ? num(raw.time) : undefined,
          msg:
            raw.msg === null || raw.msg === undefined ? null : str(raw.msg) ?? null,
          form: str(raw.form),
          raw,
        },
      ];
    }

    return [];
  }

  async setOperationOk(tzid: number | string, opts?: { ban?: 0 | 1 }): Promise<void> {
    const raw = asRecord(
      await this.request("setOperationOk", {
        tzid,
        ban: opts?.ban,
      }),
    );
    // success examples: { response: 1, tzid } or response "1"
    const resp = raw.response;
    if (resp === 0 || resp === "0") {
      throw new OnlineSimError("TRY_AGAIN_LATER", raw);
    }
  }

  async setOperationRevise(tzid: number | string): Promise<void> {
    await this.request("setOperationRevise", { tzid });
  }

  async getFreeList(): Promise<unknown> {
    // free list may work without key on some deployments; still send if present
    return this.request("getFreeList", {});
  }

  // ── Rent ──────────────────────────────────────────────────────────

  async tariffsRent(opts?: { country?: string | number }): Promise<unknown> {
    return this.request("rent/tariffsRent", {
      country: opts?.country,
    }).catch(async () =>
      // some deployments expose flat path
      this.request("tariffsRent", { country: opts?.country }),
    );
  }

  async getRentNum(opts: {
    country: string | number;
    days: number | string;
    extension?: number;
  }): Promise<GetNumResult> {
    const tryMethods = ["rent/getRentNum", "getRentNum"] as const;
    let lastErr: unknown;
    for (const method of tryMethods) {
      try {
        const raw = asRecord(
          await this.request(method, {
            country: opts.country,
            days: opts.days,
            extension: opts.extension,
          }),
        );
        // rent responses vary: tzid / item.tzid / rent.tzid
        const nested = asRecord(raw.item ?? raw.rent ?? raw.data);
        const tzid = num(raw.tzid ?? nested.tzid, NaN);
        const number = str(raw.number ?? nested.number ?? raw.phone ?? nested.phone);
        if (!Number.isFinite(tzid)) {
          throw new OnlineSimError("TRY_AGAIN_LATER", raw);
        }
        return {
          tzid,
          number,
          country: (raw.country as number | string | undefined) ?? opts.country,
          raw,
        };
      } catch (e) {
        lastErr = e;
        if (e instanceof OnlineSimError && e.code === "REQUEST_NOT_FOUND") continue;
        if (e instanceof OnlineSimError) throw e;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new OnlineSimError("TRY_AGAIN_LATER", lastErr);
  }

  async getRentState(opts?: { tzid?: number | string }): Promise<unknown> {
    try {
      return await this.request("rent/getRentState", { tzid: opts?.tzid });
    } catch (e) {
      if (e instanceof OnlineSimError && e.code === "REQUEST_NOT_FOUND") {
        return this.request("getRentState", { tzid: opts?.tzid });
      }
      throw e;
    }
  }

  async closeRentNum(tzid: number | string): Promise<unknown> {
    try {
      return await this.request("rent/closeRentNum", { tzid });
    } catch (e) {
      if (e instanceof OnlineSimError && e.code === "REQUEST_NOT_FOUND") {
        return this.request("closeRentNum", { tzid });
      }
      throw e;
    }
  }

  /**
   * Poll getState until msg/code appears or timeout.
   * Does not auto-close the operation — call setOperationOk when done.
   */
  async waitForSms(opts: {
    tzid: number | string;
    timeoutMs?: number;
    intervalMs?: number;
    /** Prefer full SMS body for parsing */
    fullMessage?: boolean;
    /** Custom code extractor; default extractSmsCode */
    parseCode?: (text: string) => string | null;
    signal?: AbortSignal;
    onTick?: (state: OperationState | undefined, attempt: number) => void;
  }): Promise<WaitForSmsResult> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const intervalMs = opts.intervalMs ?? 3_000;
    const parse = opts.parseCode ?? extractSmsCode;
    const started = Date.now();
    let attempts = 0;
    let last: OperationState | undefined;

    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) {
        throw new OnlineSimError("TRY_AGAIN_LATER", { reason: "aborted" });
      }
      attempts += 1;
      const states = await this.getState({
        tzid: opts.tzid,
        messageToCode: opts.fullMessage ? 0 : 1,
        msgList: 1,
      });
      last = states.find((s) => String(s.tzid) === String(opts.tzid)) ?? states[0];
      opts.onTick?.(last, attempts);

      const msg = last?.msg?.trim();
      if (msg) {
        const code =
          opts.fullMessage === false && /^\d{4,8}$/.test(msg)
            ? msg
            : parse(msg) ?? (/^\d{4,8}$/.test(msg) ? msg : null);
        if (code) {
          return {
            tzid: num(opts.tzid),
            number: last?.number,
            code,
            fullMessage: msg,
            state: last!,
            attempts,
            elapsedMs: Date.now() - started,
          };
        }
        // got message but no code — still return raw if message_to_code already code-like
        if (/^\d{4,8}$/.test(msg)) {
          return {
            tzid: num(opts.tzid),
            number: last?.number,
            code: msg,
            fullMessage: msg,
            state: last!,
            attempts,
            elapsedMs: Date.now() - started,
          };
        }
      }

      await sleep(intervalMs);
    }

    throw new OnlineSimError("TRY_AGAIN_LATER", {
      reason: "timeout",
      tzid: opts.tzid,
      attempts,
      elapsedMs: Date.now() - started,
      last,
    });
  }
}

export function resolveOnlineSimApiKey(explicit?: string): string | undefined {
  return (
    explicit?.trim() ||
    process.env.ONLINESIM_API_KEY?.trim() ||
    process.env.ONLINESIM_APIKEY?.trim() ||
    process.env.AWS_SITE_SHIP_ONLINESIM_KEY?.trim() ||
    undefined
  );
}
