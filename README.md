# aws-site-ship

TypeScript CLI for **headless AWS auth + static deploys** to:

```text
https://s3.amazonaws.com/<bucket>/<word1>-<word2>/index.html
```

## What "100% headless" means here

| Goal | Headless? | How |
|------|-----------|-----|
| Auth with existing keys/SSO profile | Yes | `auth -y` / env / flags |
| Create **member** AWS account | Yes | `create-account` → Organizations `CreateAccount` API |
| Assume member role + IAM deploy user + access keys | Yes | automatic after create |
| Bucket + public policy + `s3 sync` deploy | Yes | `init -y` / `deploy` / `headless` |
| Brand-new **root** account (first ever) | **No** | AWS still requires browser email/phone/payment/CAPTCHA once |

One human bootstrap (root + Organizations on a management/payer account). After that, member accounts and site deploys are fully API-driven.

## Prerequisites

- Node 20+
- AWS CLI on `PATH`
- **For headless account create:** management account with Organizations enabled and `organizations:CreateAccount` (+ `sts:AssumeRole`)

## Install

```bash
npm install
npm run build
npm link   # optional
```

## Headless one-shot

### A) You already have deploy keys

```bash
aws-site-ship headless \
  --access-key-id AKIA... \
  --secret-access-key '...' \
  --dir ./fixtures/site \
  --words forest lamp \
  --website
```

Or env:

```bash
set AWS_ACCESS_KEY_ID=AKIA...
set AWS_SECRET_ACCESS_KEY=...
set AWS_REGION=us-east-1
aws-site-ship headless --dir ./fixtures/site --words forest lamp
```

### B) Create a new member account, then deploy (Organizations)

```bash
# management credentials must already work:
aws-site-ship auth --profile mgmt -y

aws-site-ship headless \
  --create-account \
  --management-profile mgmt \
  --email you@example.com \
  --name site-forest-lamp \
  --member-profile aws-site-ship \
  --dir ./fixtures/site \
  --words forest lamp \
  --website
```

Equivalent split form:

```bash
aws-site-ship create-account \
  --email you@example.com \
  --name site-forest-lamp \
  --profile mgmt \
  --member-profile aws-site-ship \
  --json

aws-site-ship init --profile aws-site-ship --public --website -y
aws-site-ship deploy ./fixtures/site --profile aws-site-ship --words forest lamp
```

`create-account` by default **plus-stamps** the email (`you+ship-<stamp>@example.com`) so re-runs stay unique. Pass `--no-stamp` to disable.

## Commands

| Command | Headless | Purpose |
|--------|----------|---------|
| `whoami` | yes | STS identity |
| `auth` | yes with `-y` / keys | Write/verify profile |
| `create-account` | **yes** | Org CreateAccount + IAM user/keys |
| `signup` | no (browser) | Root checklist only |
| `init` | yes with `-y` | Bucket + optional public/website |
| `deploy` | yes | Sync dir → word-pair prefix |
| `headless` | **yes** | create? → auth → init → deploy |
| `open` | n/a | Open last URL |

## Env vars

| Var | Use |
|-----|-----|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | Headless auth |
| `AWS_PROFILE` / `AWS_REGION` | Standard AWS |
| `AWS_SITE_SHIP_ACCOUNT_EMAIL` | Default email for create-account |
| `AWS_SITE_SHIP_ACCOUNT_NAME` | Default account name |
| `AWS_SITE_SHIP_MGMT_PROFILE` | Management profile |
| `AWS_SITE_SHIP_MEMBER_PROFILE` | Member profile (default `aws-site-ship`) |
| `AWS_SITE_SHIP_CREATE_ACCOUNT=1` | headless implies create-account |
| `AWS_SITE_SHIP_PRIVATE=1` | headless skips public policy |
| `AWS_SITE_SHIP_WEBSITE=1` | headless enables website endpoint |
| `AWS_SITE_SHIP_NO_STAMP=1` | disable email plus-stamp |

## Config

`~/.aws-site-ship/config.json` — profile name, bucket, last deploy, last member account id. **Secrets stay in `~/.aws`.**

## IAM (management account) for create-account

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "organizations:CreateAccount",
        "organizations:DescribeCreateAccountStatus",
        "organizations:ListAccounts"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/OrganizationAccountAccessRole"
    }
  ]
}
```

## Dev

```bash
npm run dev -- headless --help
npm run build
node dist/index.js create-account --help
```

## Honest limits

- Automating **root** signup scrapers (CAPTCHA farms, SMS, payment bots) is intentionally **out of scope**.
- Organizations **CreateAccount** still needs a unique reachable email; AWS may email the address, but the API path does not need a browser.
- First-time org setup (enable Organizations, billing) is a one-time console step on the management account.
