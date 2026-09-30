/**
 * Disposable email via mail.tm public API (https://api.mail.tm).
 * temp.tf has no documented API — we open it in a browser when requested.
 */
import { randomBytes } from "node:crypto";

const MAILTM = "https://api.mail.tm";
export const TEMP_TF_URL = "https://temp.tf/";

export class TempMailError extends Error {
  readonly status: number;
  readonly payload: unknown;
  constructor(message: string, status = 0, payload?: unknown) {
    super(message);
    this.name = "TempMailError";
    this.status = status;
    this.payload = payload;
  }
}

export type TempInbox = {
  id: string;
  address: string;
  password: string;
  token: string;
};

export type TempMessage = {
  id: string;
  from: string;
  subject: string;
  intro?: string;
  text?: string;
  html?: string[];
  createdAt?: string;
  raw: Record<string, unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function randLocal(len = 10): string {
  return randomBytes(len).toString("hex").slice(0, len);
}

export class TempMailClient {
  private readonly fetchImpl: typeof fetch;
  constructor(opts?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string },
  ): Promise<T> {
    const res = await this.fetchImpl(`${MAILTM}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(opts?.body ? { "Content-Type": "application/json" } : {}),
        ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new TempMailError(
        `mail.tm ${method} ${path}: HTTP ${res.status}`,
        res.status,
        data,
      );
    }
    return data as T;
  }

  async listDomains(): Promise<string[]> {
    const data = await this.request<unknown>("GET", "/domains");
    // mail.tm historically returned Hydra; currently may return a bare array
    const members = Array.isArray(data)
      ? data
      : Array.isArray(asRecord(data)["hydra:member"])
        ? (asRecord(data)["hydra:member"] as unknown[])
        : Array.isArray(asRecord(data).member)
          ? (asRecord(data).member as unknown[])
          : [];
    return members
      .map((m) => asRecord(m))
      .filter((m) => m.isActive !== false)
      .map((m) => String(m.domain ?? ""))
      .filter(Boolean);
  }

  async createInbox(opts?: {
    local?: string;
    domain?: string;
    password?: string;
  }): Promise<TempInbox> {
    const domains = await this.listDomains();
    const domain = opts?.domain || domains[0];
    if (!domain) throw new TempMailError("No active mail.tm domains", 500);
    const local = (opts?.local || `ship${randLocal(8)}`).toLowerCase();
    const address = `${local}@${domain}`;
    const password = opts?.password || `Aw5!${randLocal(12)}`;

    const created = asRecord(
      await this.request("POST", "/accounts", {
        body: { address, password },
      }),
    );

    const tokenPayload = asRecord(
      await this.request("POST", "/token", {
        body: { address, password },
      }),
    );

    return {
      id: String(created.id ?? ""),
      address,
      password,
      token: String(tokenPayload.token ?? ""),
    };
  }

  async listMessages(token: string): Promise<TempMessage[]> {
    const data = await this.request<unknown>("GET", "/messages", { token });
    const members = Array.isArray(data)
      ? data
      : Array.isArray(asRecord(data)["hydra:member"])
        ? (asRecord(data)["hydra:member"] as unknown[])
        : Array.isArray(asRecord(data).member)
          ? (asRecord(data).member as unknown[])
          : [];
    return members.map((m) => {
      const raw = asRecord(m);
      const from = asRecord(raw.from);
      return {
        id: String(raw.id ?? ""),
        from: String(from.address ?? from.name ?? ""),
        subject: String(raw.subject ?? ""),
        intro: raw.intro !== undefined ? String(raw.intro) : undefined,
        createdAt: raw.createdAt !== undefined ? String(raw.createdAt) : undefined,
        raw,
      };
    });
  }

  async getMessage(token: string, id: string): Promise<TempMessage> {
    const raw = asRecord(await this.request("GET", `/messages/${id}`, { token }));
    const from = asRecord(raw.from);
    return {
      id: String(raw.id ?? id),
      from: String(from.address ?? ""),
      subject: String(raw.subject ?? ""),
      intro: raw.intro !== undefined ? String(raw.intro) : undefined,
      text: raw.text !== undefined ? String(raw.text) : undefined,
      html: Array.isArray(raw.html) ? raw.html.map(String) : undefined,
      createdAt: raw.createdAt !== undefined ? String(raw.createdAt) : undefined,
      raw,
    };
  }

  /** Poll until a message arrives (optionally matching subject/from). */
  async waitForMessage(opts: {
    token: string;
    timeoutMs?: number;
    intervalMs?: number;
    match?: RegExp;
    signal?: AbortSignal;
    onTick?: (count: number, attempt: number) => void;
  }): Promise<TempMessage> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const intervalMs = opts.intervalMs ?? 4_000;
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) {
        throw new TempMailError("aborted", 499);
      }
      attempt += 1;
      const list = await this.listMessages(opts.token);
      opts.onTick?.(list.length, attempt);
      for (const m of list) {
        const hay = `${m.subject}\n${m.intro ?? ""}\n${m.from}`;
        if (!opts.match || opts.match.test(hay)) {
          return this.getMessage(opts.token, m.id);
        }
      }
      await sleep(intervalMs);
    }
    throw new TempMailError("timeout waiting for email", 408);
  }
}

/** Pull first https URL / verification-looking link from message body. */
export function extractVerifyLink(msg: TempMessage): string | null {
  const blob = [msg.text, ...(msg.html ?? []), msg.intro ?? ""].filter(Boolean).join("\n");
  const urls = blob.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const prefer = urls.find((u) =>
    /verify|confirm|signin\.aws|amazon\.com|account/i.test(u),
  );
  return prefer ?? urls[0] ?? null;
}

export function extractEmailCode(msg: TempMessage): string | null {
  const blob = [msg.subject, msg.intro, msg.text, ...(msg.html ?? [])]
    .filter(Boolean)
    .join("\n");
  const m = blob.match(/\b(\d{4,8})\b/);
  return m?.[1] ?? null;
}
