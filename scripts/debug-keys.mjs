import { readFileSync } from "node:fs";

const envText = readFileSync(".env", "utf8");
function get(key) {
  const line = envText.split(/\r?\n/).find((l) => l.startsWith(key + "="));
  if (!line) return null;
  let v = line.slice(key.length + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

const mercury = get("MERCURY_API_TOKEN") || "";
const osKey = get("ONLINESIM_API_KEY") || "";
console.log(
  JSON.stringify(
    {
      onlinesimLen: osKey.length,
      mercuryLen: mercury.length,
      mercuryHasSecretPrefix: mercury.startsWith("secret-token:"),
      mercuryHasWhitespace: /\s/.test(mercury),
      mercuryStart: mercury.slice(0, 18),
      mercuryEnd: mercury.slice(-6),
    },
    null,
    2,
  ),
);

const domains = await fetch("https://api.mail.tm/domains", {
  headers: { Accept: "application/json" },
});
const dj = await domains.json();
const members = dj["hydra:member"] || dj.member || [];
console.log(
  "mail.tm status",
  domains.status,
  "members",
  members.length,
  "sample",
  members[0],
);

async function tryMercury(label, headers) {
  const res = await fetch("https://api.mercury.com/api/v1/accounts", {
    headers: { Accept: "application/json", ...headers },
  });
  console.log("mercury", label, res.status);
}

if (mercury) {
  await tryMercury("bearer-as-is", { Authorization: `Bearer ${mercury}` });
  const withPrefix = mercury.startsWith("secret-token:")
    ? mercury
    : `secret-token:${mercury}`;
  await tryMercury("bearer-prefix", {
    Authorization: `Bearer ${withPrefix}`,
  });
  await tryMercury("basic-as-is", {
    Authorization: `Basic ${Buffer.from(`${mercury}:`).toString("base64")}`,
  });
  await tryMercury("basic-prefix", {
    Authorization: `Basic ${Buffer.from(`${withPrefix}:`).toString("base64")}`,
  });
}
