# TypeScript CLI: AWS Auth + One-Command Static Site Deploy

## 1. What the signup page actually shows (scraped)

URL: `https://signin.aws.amazon.com/signup?request_type=register`

Visible first-step fields:
- **Root user email address** — recovery + identity
- **AWS account name** — display name (changeable later)
- CTA: **Verify email address**
- Alt path: sign in to an existing account
- Marketing: Free Tier / credits messaging
- Legal: Privacy Notice, Cookie Notice, Terms of Use

**Not on step 1 (come later in AWS’s real flow):** password, phone/SMS (or voice) verification, payment method, identity checks, CAPTCHA / fraud gates, console login.

### Hard constraint (plan around this)

AWS **does not** offer a supported public API to fully create a root account headlessly. Signup is browser-bound and includes email verify, contact/payment, and bot defenses. A CLI that “fully registers AWS accounts automatically” will be brittle, ToS-risky, and break constantly.

**This plan does the useful, durable thing instead:**

| Phase | What the CLI does | Automation level |
|-------|-------------------|------------------|
| A | Guide / open signup + capture inputs you already have | Semi-manual (you finish verify in browser once) |
| B | Configure **AWS CLI auth** (profile, keys or SSO) automatically | Full |
| C | Deploy static site → URL shaped like `https://s3.amazonaws.com/<bucket>/<word1>-<word2>/index.html` | Full |

---

## 2. Product goal

```bash
npx aws-site-ship init          # one-time: profile + bucket + hosting
npx aws-site-ship auth          # refresh/configure credentials via AWS CLI
npx aws-site-ship deploy ./dist # upload + print URL
npx aws-site-ship open          # open last deploy URL
```

**Default URL shape**

- Path-style: `https://s3.amazonaws.com/<bucket>/<word1>-<word2>/index.html`
- Or virtual-hosted: `https://<bucket>.s3.<region>.amazonaws.com/<word1>-<word2>/index.html`
- Optional upgrade: S3 website endpoint or CloudFront + friendly domain later

> **Note on `word1+word2`:** `+` is a bad bucket/key habit (URL encoding, bucket naming rules). Use `word1-word2` or `word1word2`. CLI will accept two words and join with `-` unless `--joiner` is set.

---

## 3. Architecture

```
aws-site-ship/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # commander entry
│   ├── config.ts                # load/save ~/.aws-site-ship/config.json
│   ├── commands/
│   │   ├── init.ts
│   │   ├── auth.ts
│   │   ├── deploy.ts
│   │   ├── signup.ts            # opens browser + checklist only
│   │   └── whoami.ts
│   ├── aws/
│   │   ├── cli.ts               # spawn `aws` CLI helpers
│   │   ├── s3.ts                # bucket ensure, put, website/public access
│   │   └── credentials.ts       # profile / env / SSO detect
│   ├── words.ts                 # word pair → path segment
│   └── ui.ts                    # prompts (prompts/inquirer) + chalk
└── README.md
```

**Stack**
- **Runtime:** Node 20+
- **Language:** TypeScript (ESM)
- **CLI parser:** `commander`
- **Prompts:** `@inquirer/prompts`
- **AWS:** prefer **AWS CLI v2** subprocess for auth parity with your shell; optional `@aws-sdk/client-s3` for uploads (faster/parallel)
- **Config:** `conf` or plain JSON under `~/.aws-site-ship/`
- **Browser open:** `open` package (signup helper only)

---

## 4. Auth model (automatic, supported)

Do **not** scrape the signup form to mint root users. Do automate **developer auth** the way AWS expects:

### 4.1 Supported auth paths (implement in order)

1. **Existing named profile**  
   - Read `~/.aws/credentials` + `~/.aws/config`  
   - `aws sts get-caller-identity --profile <name>`

2. **Access key bootstrap** (guided)  
   ```bash
   aws configure --profile aws-site-ship
   # or non-interactive:
   aws configure set aws_access_key_id ... --profile aws-site-ship
   aws configure set aws_secret_access_key ... --profile aws-site-ship
   aws configure set region us-east-1 --profile aws-site-ship
   ```

3. **SSO (recommended for real orgs)**  
   ```bash
   aws configure sso --profile aws-site-ship
   aws sso login --profile aws-site-ship
   ```
   CLI wraps: detect expired SSO → run `aws sso login` → wait → verify identity.

4. **Env vars**  
   Honor `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_PROFILE` / `AWS_REGION`.

### 4.2 `auth` command behavior

```
auth
  1. Resolve profile (flag → config → env → default)
  2. Run get-caller-identity
  3. If fail + SSO profile → aws sso login, retry
  4. If fail + no keys → interactive configure OR print IAM user “create access key” checklist
  5. Persist profile name + account id + arn + region to tool config
  6. Exit 0 with summary
```

### 4.3 `signup` command (honest helper, not a bot)

```
signup
  - open https://signin.aws.amazon.com/signup?request_type=register
  - print checklist:
      [ ] root email + account name
      [ ] verify email
      [ ] password
      [ ] contact / phone verify
      [ ] payment method (Free Tier)
      [ ] create IAM user (Admin or deploy-scoped) — NEVER daily-drive root keys
      [ ] create access key OR enable IAM Identity Center (SSO)
  - prompt: “Paste access key / profile when done” → hand off to `auth`
```

---

## 5. Deploy model

### 5.1 Target layout

```
s3://<bucket>/<word1>-<word2>/
  index.html
  assets/...
```

Public URL (path-style example):

```text
https://s3.amazonaws.com/<bucket>/<word1>-<word2>/index.html
```

### 5.2 Bucket strategy

- **Shared bucket** (default): one bucket e.g. `site-ship-<accountId>`, many path prefixes (`word` pairs = “sites”)
- **Per-site bucket** (optional flag): bucket name derived from words (must satisfy S3 naming: 3–63 chars, lowercase, no `+`)

### 5.3 `init` steps

1. Ensure auth (`auth` internally)
2. Choose region (default `us-east-1` — path-style `s3.amazonaws.com` is least surprising there)
3. Ensure bucket exists (`head-bucket` / `create-bucket`)
4. Apply **deploy policy** options (pick one, document clearly):

   **Option A — Public objects via Bucket Policy (classic static host)**  
   - Turn off “Block public access” *only if user consents*  
   - Bucket policy `s3:GetObject` on `arn:aws:s3:::bucket/prefix/*`  
   - Optional: `static website hosting` with `index.html`

   **Option B — Private + CloudFront OAC (better default for real sites)**  
   - Keep bucket private  
   - CloudFront distribution, OAC, default root object  
   - Longer init; nicer HTTPS URLs  

   **MVP = Option A** with loud confirm; **v2 = Option B**.

5. Save: `{ profile, region, bucket, defaultPrefixTemplate, publicMode }`

### 5.4 `deploy` steps

```
deploy [dir=./dist]
  --words <w1> <w2>     # optional; else random word pair or from package.json name
  --prefix <path>       # override
  --profile / --bucket / --region
  1. auth check
  2. resolve prefix = word1-word2
  3. sync files:
       aws s3 sync ./dist s3://bucket/prefix/ --delete
     or SDK multipart put with content-type map
  4. ensure index.html present
  5. print URLs:
       - path-style
       - virtual-hosted
       - website endpoint if enabled
  6. write last deploy meta to config
```

### 5.5 Content-Type map (if using SDK)

| Ext | Type |
|-----|------|
| .html | text/html; charset=utf-8 |
| .js | application/javascript |
| .css | text/css |
| .json | application/json |
| .svg | image/svg+xml |
| .png/.jpg/… | image/* |
| .wasm | application/wasm |

### 5.6 IAM policy minimum (document in README)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:PutBucketWebsite",
        "s3:PutPublicAccessBlock",
        "s3:GetPublicAccessBlock",
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::site-ship-*",
        "arn:aws:s3:::site-ship-*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    }
  ]
}
```

(Tighten bucket ARNs once name is fixed.)

---

## 6. Word pair → path

```ts
// words.ts
// - two English words from a small built-in list (or --words)
// - normalize: lowercase, strip non-alnum, join with "-"
// - reject empty / too long (> 50)
// Example: "Forest" + "Lamp" → "forest-lamp"
// URL: https://s3.amazonaws.com/my-bucket/forest-lamp/index.html
```

Optional: `unique` mode appends short suffix `forest-lamp-a3f1` to avoid clobber.

---

## 7. CLI UX sketch

```bash
# first time on a machine with no AWS account yet
aws-site-ship signup          # browser + checklist
aws-site-ship auth            # configure profile / SSO / keys
aws-site-ship init            # bucket + policy
aws-site-ship deploy ./dist --words my portfolio

# later
aws-site-ship deploy
aws-site-ship whoami
```

**Flags (global)**  
`--profile` `--region` `--bucket` `--json` (machine output) `--yes`

**Exit codes**  
`0` ok · `1` usage · `2` auth · `3` aws api · `4` local files

---

## 8. Implementation order (milestones)

### M0 — Scaffold (½ day)
- [ ] `package.json` bin → `dist/index.js`
- [ ] `tsconfig` ESM, `tsx` dev, `tsup` or `tsc` build
- [ ] `commander` with stub commands
- [ ] README with auth + IAM prerequisites

### M1 — Auth module (1 day)
- [ ] Detect AWS CLI present (`aws --version`)
- [ ] `getCallerIdentity()`
- [ ] Profile list / select
- [ ] `aws configure` + `aws sso login` wrappers
- [ ] Persist tool config
- [ ] `whoami` command

### M2 — S3 ensure + deploy (1–2 days)
- [ ] Create/head bucket (region-correct `LocationConstraint`)
- [ ] Public access + policy helpers behind `--public` confirm
- [ ] `s3 sync` wrapper or SDK upload with content types
- [ ] URL printer (path-style + virtual-hosted)
- [ ] `deploy` end-to-end on a toy `index.html`

### M3 — Words + DX (½ day)
- [ ] Word list + `--words` + collision suffix
- [ ] Last-deploy cache + `open`
- [ ] `--json` output for scripting

### M4 — Signup helper (½ day)
- [ ] Open register URL
- [ ] Checklist + “when done → auth” handoff
- [ ] Explicit docs: no headless root-account creation

### M5 — Hardening (ongoing)
- [ ] Dry-run mode
- [ ] Retry on `SlowDown` / creds expiry
- [ ] CloudFront optional path
- [ ] Tests: unit for words/urls; integration behind `AWS_SITE_SHIP_IT=1`

---

## 9. Core TypeScript shapes

```ts
export type ShipConfig = {
  profile: string;
  region: string;
  bucket: string;
  publicRead: boolean;
  websiteHosting: boolean;
  lastDeploy?: {
    prefix: string;
    url: string;
    at: string; // ISO
  };
};

export type DeployResult = {
  bucket: string;
  prefix: string;
  region: string;
  urls: {
    pathStyle: string;
    virtualHosted: string;
    website?: string;
  };
  objectCount: number;
};
```

**URL builders**

```ts
pathStyle:     `https://s3.amazonaws.com/${bucket}/${prefix}/index.html`
virtualHosted: `https://${bucket}.s3.${region}.amazonaws.com/${prefix}/index.html`
website:       `http://${bucket}.s3-website-${region}.amazonaws.com/${prefix}/` // region form varies
```

---

## 10. Example `aws` CLI calls the tool wraps

```bash
# identity
aws sts get-caller-identity --profile aws-site-ship

# bucket (us-east-1 = no LocationConstraint)
aws s3api create-bucket --bucket site-ship-123456789012 --region us-east-1

# public access block (only if user opted into public objects)
aws s3api put-public-access-block --bucket ... --public-access-block-configuration \
  BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false

# policy + optional website
aws s3api put-bucket-policy --bucket ... --policy file://policy.json
aws s3 website s3://bucket/ --index-document index.html

# deploy
aws s3 sync ./dist s3://bucket/forest-lamp/ --delete --cache-control "max-age=60"
```

---

## 11. Security / abuse boundaries (build these in)

- Never ask for root password in the CLI; never store root passwords.
- Prefer IAM user or SSO role with least privilege.
- Default **private** bucket; public requires explicit `--public` and typed confirm.
- Do not automate CAPTCHA, SMS farms, or bulk account creation.
- Keys live in AWS shared credentials file / SSO cache — tool stores **profile name**, not secrets.
- README warns: public `s3.amazonaws.com/.../index.html` is fine for demos; use CloudFront + HTTPS for anything real.

---

## 12. Out of scope (v1)

- Full headless AWS root registration
- Payment-method automation
- Bypass of email/phone verification
- Multi-account Organizations SCPs bootstrap (nice later)
- Custom domain DNS (Route53) — v2
- CI templates (GitHub Actions) — easy add after M2

---

## 13. Success criteria

1. On a machine with AWS CLI + valid profile, `deploy ./dist --words hello world` uploads and prints a working `index.html` URL without touching the AWS console.
2. On a fresh laptop, `signup` → human finishes AWS register → `auth` → `init` → `deploy` is documented and works in &lt; 15 minutes.
3. No secrets in project repo; config is user-local.
4. URL matches the spirit of `s3.amazonaws.com/<word1>-<word2>/index.html` (with valid naming).

---

## 14. Suggested first code slice

Implement in this order when you say “go”:

1. Scaffold package + `whoami` (CLI detection + `sts get-caller-identity`)
2. `deploy` assuming bucket already exists + credentials work
3. `init` bucket create + optional public policy
4. `auth` / `signup` helpers
5. Word pairs + polish

That gets you a useful deploy tool fastest; account *creation* stays a guided browser step, account *use* is fully automatic.

---

## 15. Headless mode (v0.2)

### What is actually 100% headless
- `auth -y` with `--access-key-id` / env keys (no prompts)
- `create-account` via **AWS Organizations CreateAccount** API
- Assume `OrganizationAccountAccessRole` → create IAM deploy user → `aws configure set` keys
- `init -y` + `deploy` + one-shot `headless` pipeline

### What cannot be headless (AWS limitation)
- Brand-new **root** registration (email verify, phone, payment, CAPTCHA)
- Enabling Organizations the very first time on a virgin root (one console bootstrap)

### Commands added
- `aws-site-ship create-account --email … --name …`
- `aws-site-ship headless [--create-account] [--access-key-id …] --dir … --words …`

### Flow
```
management profile
    → organizations:CreateAccount (poll DescribeCreateAccountStatus)
    → sts:AssumeRole OrganizationAccountAccessRole
    → iam:CreateUser + CreateAccessKey (+ AttachUserPolicy)
    → aws configure set (member profile)
    → s3 ensure bucket + optional public policy
    → s3 sync → https://s3.amazonaws.com/<bucket>/<word1>-<word2>/index.html
```
