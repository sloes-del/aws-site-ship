import {
  OnlineSimClient,
  OnlineSimError,
  extractSmsCode,
  resolveOnlineSimApiKey,
  type OperationState,
  type TariffOffer,
} from "../onlinesim/client.js";
import { loadConfig, saveConfig } from "../config.js";
import { fail, log, printJson } from "../ui.js";

function clientFromOpts(opts: { apikey?: string; lang?: string }): OnlineSimClient {
  const apiKey = resolveOnlineSimApiKey(opts.apikey) || loadConfig().onlinesimApiKey;
  if (!apiKey) {
    fail(
      "onlinesim API key required.\n" +
        "  Pass --apikey <key>  or set ONLINESIM_API_KEY\n" +
        "  Get a key: https://onlinesim.io/v2/profile/ (API tab)\n" +
        "  Optional: aws-site-ship onlinesim auth --apikey <key>  (saves to config)",
      2,
    );
  }
  return new OnlineSimClient({
    apiKey,
    lang: (opts.lang as "en") || "en",
  });
}

function printErr(err: unknown): never {
  if (err instanceof OnlineSimError) {
    fail(`onlinesim ${err.code}${err.payload ? `\n  ${JSON.stringify(err.payload)}` : ""}`, 3);
  }
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg, 3);
}

function persistLast(op: {
  tzid: number;
  number?: string;
  service?: string;
  country?: string | number;
  mode: "sms" | "rent";
}): void {
  saveConfig({
    lastOnlineSim: {
      tzid: op.tzid,
      number: op.number,
      service: op.service,
      country: op.country !== undefined ? String(op.country) : undefined,
      mode: op.mode,
      at: new Date().toISOString(),
    },
  });
}

/** Save API key into tool config (optional; env still preferred). */
export async function onlinesimAuthCommand(opts: {
  apikey?: string;
  json?: boolean;
}): Promise<void> {
  const key = resolveOnlineSimApiKey(opts.apikey);
  if (!key) {
    fail("Pass --apikey or set ONLINESIM_API_KEY", 2);
  }
  const client = new OnlineSimClient({ apiKey: key, lang: "en" });
  try {
    const bal = await client.getBalance();
    saveConfig({ onlinesimApiKey: key });
    const payload = {
      ok: true,
      saved: true,
      configPath: "onlinesimApiKey in ~/.aws-site-ship/config.json",
      balance: bal.balance,
      zbalance: bal.zbalance,
    };
    if (opts.json) {
      printJson(payload);
      return;
    }
    log.title("onlinesim auth");
    log.ok(`API key saved · balance ${bal.balance} (frozen ${bal.zbalance})`);
    log.dim("Prefer ONLINESIM_API_KEY env in CI; config is for local convenience.");
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimBalanceCommand(opts: {
  apikey?: string;
  income?: boolean;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  try {
    const bal = await client.getBalance({ income: opts.income });
    if (opts.json) {
      printJson(bal);
      return;
    }
    log.title("onlinesim balance");
    log.ok(`Available  ${bal.balance}`);
    log.info(`Frozen     ${bal.zbalance}`);
    if (bal.income !== undefined) log.info(`Referral   ${bal.income}`);
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimTariffsCommand(opts: {
  apikey?: string;
  country?: string;
  service?: string;
  cheapest?: boolean;
  limit?: string;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  try {
    if (opts.cheapest || opts.service) {
      const service = opts.service || loadConfig().onlinesimDefaultService || "amazon";
      const ranked = await client.cheapestCountries(service);
      const limit = Math.max(1, Number(opts.limit || 15));
      const slice = ranked.slice(0, limit);
      if (opts.json || opts.cheapest) {
        printJson({
          service,
          count: ranked.length,
          cheapest: slice[0] ?? null,
          countries: slice.map((o) => ({
            country: o.country,
            countryName: o.countryName,
            price: o.price,
            count: o.count,
            service: o.service,
          })),
        });
        return;
      }
    }

    const data = await client.getTariffs({
      country: opts.country,
      filterService: opts.service,
    });
    // tariffs payloads are large/nested — always JSON
    printJson(data);
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimNumberCommand(opts: {
  apikey?: string;
  service?: string;
  country?: string;
  /** Pick cheapest in-stock country (and failover) */
  cheapest?: boolean;
  maxAttempts?: string;
  /** rent mode */
  rent?: boolean;
  days?: string;
  wait?: boolean;
  timeout?: string;
  finish?: boolean;
  json?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const service = opts.service || cfg.onlinesimDefaultService || "amazon";
  const wantCheapest =
    Boolean(opts.cheapest) ||
    (!opts.country && process.env.AWS_SITE_SHIP_ONLINESIM_CHEAPEST !== "0");
  // Explicit --country wins; else cheapest-by-default for SMS mode
  const countryFixed = opts.country || undefined;
  const client = clientFromOpts(opts);

  try {
    if (opts.rent) {
      let country =
        countryFixed || cfg.onlinesimDefaultCountry || "7";
      if (opts.cheapest && !countryFixed) {
        log.warn(
          "Rent cheapest-country ranking is best-effort; using default country unless --country set",
        );
      }
      const days = opts.days || "1";
      log.info(`Renting number country=${country} days=${days}…`);
      const got = await client.getRentNum({ country, days });
      persistLast({
        tzid: got.tzid,
        number: got.number,
        country,
        mode: "rent",
      });
      saveConfig({
        onlinesimDefaultCountry: String(country),
      });

      const payload = {
        ok: true,
        mode: "rent" as const,
        tzid: got.tzid,
        number: got.number,
        country,
        days,
      };
      if (opts.json) {
        printJson(payload);
        return;
      }
      log.title("onlinesim rent");
      log.ok(`Number  ${got.number ?? "(see getRentState)"}`);
      log.ok(`tzid    ${got.tzid}`);
      log.dim("Poll: aws-site-ship onlinesim state --tzid " + got.tzid);
      return;
    }

    let got: {
      tzid: number;
      number?: string;
      country?: string | number;
      service?: string;
      sum?: number;
      offer?: TariffOffer;
      attempts?: number;
    };
    let country: string;

    if (countryFixed) {
      country = countryFixed;
      log.info(`Ordering number service=${service} country=${country}…`);
      const n = await client.getNum({ service, country, number: true });
      got = n;
    } else if (wantCheapest) {
      log.info(`Ordering number service=${service} (cheapest country first)…`);
      const n = await client.getNumCheapest({
        service,
        maxAttempts: Number(opts.maxAttempts || 8),
        number: true,
        onAttempt: (offer, index, err) => {
          if (err) {
            const code =
              err instanceof OnlineSimError ? err.code : "error";
            log.dim(
              `  skip country ${offer.country} @ ${offer.price} (${code})`,
            );
          } else if (index === 0) {
            log.info(
              `  try country ${offer.country}${offer.countryName ? ` (${offer.countryName})` : ""} @ ${offer.price} stock=${offer.count}`,
            );
          } else {
            log.dim(
              `  try country ${offer.country} @ ${offer.price} stock=${offer.count}`,
            );
          }
        },
      });
      got = n;
      country = String(n.offer.country);
      log.ok(
        `Cheapest hit: country ${country} price=${n.offer.price} (attempt ${n.attempts})`,
      );
    } else {
      country = cfg.onlinesimDefaultCountry || "7";
      log.info(`Ordering number service=${service} country=${country}…`);
      const n = await client.getNum({ service, country, number: true });
      got = n;
    }

    persistLast({
      tzid: got.tzid,
      number: got.number,
      service,
      country,
      mode: "sms",
    });
    saveConfig({
      onlinesimDefaultService: service,
      onlinesimDefaultCountry: String(country),
    });

    let sms:
      | {
          code: string;
          fullMessage?: string;
          elapsedMs: number;
        }
      | undefined;

    if (opts.wait) {
      const timeoutMs = Number(opts.timeout || 180) * 1000;
      log.info(`Waiting for SMS (timeout ${timeoutMs / 1000}s)…`);
      const result = await client.waitForSms({
        tzid: got.tzid,
        timeoutMs,
        fullMessage: true,
        onTick: (st, attempt) => {
          if (attempt === 1 || attempt % 5 === 0) {
            log.dim(
              `  poll #${attempt} ${st?.response ?? "?"} msg=${st?.msg ? "yes" : "no"}`,
            );
          }
        },
      });
      sms = {
        code: result.code,
        fullMessage: result.fullMessage,
        elapsedMs: result.elapsedMs,
      };
      if (opts.finish !== false) {
        await client.setOperationOk(got.tzid).catch(() => {
          /* still return code */
        });
      }
    }

    const payload = {
      ok: true,
      mode: "sms" as const,
      tzid: got.tzid,
      number: got.number,
      service,
      country,
      sum: got.sum ?? got.offer?.price,
      offer: got.offer
        ? {
            country: got.offer.country,
            countryName: got.offer.countryName,
            price: got.offer.price,
            count: got.offer.count,
          }
        : undefined,
      attempts: got.attempts,
      sms,
    };

    if (opts.json) {
      printJson(payload);
      return;
    }

    log.title("onlinesim number");
    log.ok(`Number   ${got.number ?? "(check state)"}`);
    log.ok(`tzid     ${got.tzid}`);
    log.info(
      `Service  ${service} · country ${country}${got.offer ? ` · price ${got.offer.price}` : ""}`,
    );
    if (sms) {
      log.ok(`Code     ${sms.code}`);
      if (sms.fullMessage) log.dim(`SMS      ${sms.fullMessage}`);
    } else {
      log.dim(
        `Next: aws-site-ship onlinesim wait --tzid ${got.tzid}   or   onlinesim state`,
      );
    }
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimStateCommand(opts: {
  apikey?: string;
  tzid?: string;
  full?: boolean;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  const tzid = opts.tzid || (loadConfig().lastOnlineSim?.tzid !== undefined
    ? String(loadConfig().lastOnlineSim!.tzid)
    : undefined);

  try {
    const states = await client.getState({
      tzid,
      messageToCode: opts.full ? 0 : 1,
      msgList: 1,
    });

    if (opts.json) {
      printJson(states);
      return;
    }

    log.title("onlinesim state");
    if (!states.length) {
      log.warn("No active operations");
      return;
    }
    for (const st of states) {
      printState(st);
    }
  } catch (e) {
    printErr(e);
  }
}

function printState(st: OperationState): void {
  console.log(
    `  tzid=${st.tzid}  ${st.response}  ${st.number ?? ""}  ${st.service ?? ""}`,
  );
  if (st.msg) {
    const code = extractSmsCode(st.msg) ?? (/^\d{4,8}$/.test(st.msg) ? st.msg : null);
    log.ok(`  msg: ${st.msg}${code && code !== st.msg ? `  → code ${code}` : ""}`);
  }
  if (st.time !== undefined) log.dim(`  time left-ish: ${st.time}`);
}

export async function onlinesimWaitCommand(opts: {
  apikey?: string;
  tzid?: string;
  timeout?: string;
  interval?: string;
  finish?: boolean;
  json?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const tzid = opts.tzid || (cfg.lastOnlineSim?.tzid !== undefined
    ? String(cfg.lastOnlineSim.tzid)
    : undefined);
  if (!tzid) {
    fail("Need --tzid (or a prior onlinesim number in config)", 2);
  }
  const client = clientFromOpts(opts);
  const timeoutMs = Number(opts.timeout || 180) * 1000;
  const intervalMs = Number(opts.interval || 3) * 1000;

  try {
    log.info(`Waiting on tzid=${tzid} (timeout ${timeoutMs / 1000}s)…`);
    const result = await client.waitForSms({
      tzid,
      timeoutMs,
      intervalMs,
      fullMessage: true,
      onTick: (st, attempt) => {
        if (attempt === 1 || attempt % 5 === 0) {
          log.dim(
            `  poll #${attempt} ${st?.response ?? "?"} ${st?.msg ? "msg=yes" : "msg=no"}`,
          );
        }
      },
    });

    if (opts.finish) {
      await client.setOperationOk(tzid);
      log.dim("Operation closed (setOperationOk)");
    }

    const payload = {
      ok: true,
      tzid: result.tzid,
      number: result.number ?? cfg.lastOnlineSim?.number,
      code: result.code,
      fullMessage: result.fullMessage,
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
    };

    if (opts.json) {
      printJson(payload);
      return;
    }

    log.title("onlinesim SMS");
    log.ok(`Code    ${result.code}`);
    if (result.fullMessage) log.info(`SMS     ${result.fullMessage}`);
    log.dim(`after ${result.attempts} polls / ${Math.round(result.elapsedMs / 1000)}s`);
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimFinishCommand(opts: {
  apikey?: string;
  tzid?: string;
  ban?: boolean;
  json?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const tzid = opts.tzid || (cfg.lastOnlineSim?.tzid !== undefined
    ? String(cfg.lastOnlineSim.tzid)
    : undefined);
  if (!tzid) fail("Need --tzid (or last onlinesim op in config)", 2);
  const client = clientFromOpts(opts);
  try {
    await client.setOperationOk(tzid, { ban: opts.ban ? 1 : 0 });
    if (opts.json) {
      printJson({ ok: true, tzid, closed: true });
      return;
    }
    log.ok(`Closed operation tzid=${tzid}`);
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimReviseCommand(opts: {
  apikey?: string;
  tzid?: string;
  json?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const tzid = opts.tzid || (cfg.lastOnlineSim?.tzid !== undefined
    ? String(cfg.lastOnlineSim.tzid)
    : undefined);
  if (!tzid) fail("Need --tzid", 2);
  const client = clientFromOpts(opts);
  try {
    await client.setOperationRevise(tzid);
    if (opts.json) {
      printJson({ ok: true, tzid, revise: true });
      return;
    }
    log.ok(`Revise requested for tzid=${tzid} — waiting for next SMS`);
    log.dim("Run: aws-site-ship onlinesim wait --tzid " + tzid);
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimRentStateCommand(opts: {
  apikey?: string;
  tzid?: string;
  json?: boolean;
}): Promise<void> {
  const client = clientFromOpts(opts);
  try {
    const data = await client.getRentState({ tzid: opts.tzid });
    printJson(data);
  } catch (e) {
    printErr(e);
  }
}

export async function onlinesimRentCloseCommand(opts: {
  apikey?: string;
  tzid?: string;
  json?: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const tzid = opts.tzid || (cfg.lastOnlineSim?.mode === "rent"
    ? String(cfg.lastOnlineSim.tzid)
    : undefined);
  if (!tzid) fail("Need --tzid for rent close", 2);
  const client = clientFromOpts(opts);
  try {
    const data = await client.closeRentNum(tzid);
    if (opts.json) {
      printJson({ ok: true, tzid, result: data });
      return;
    }
    log.ok(`Rent closed tzid=${tzid}`);
  } catch (e) {
    printErr(e);
  }
}
