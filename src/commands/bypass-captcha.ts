import { log } from "../ui.js";

/**
 * AWS root signup CAPTCHA/phone/payment cannot be solved via a supported API.
 * The durable "way around" is: never create a root in a bot — use Organizations
 * CreateAccount on a management account you already own (one human bootstrap).
 */
export async function bypassCaptchaCommand(opts: {
  json?: boolean;
}): Promise<void> {
  const payload = {
    ok: true,
    strategy: "organizations-create-account",
    avoids: [
      "root signup CAPTCHA",
      "root phone/SMS gate",
      "root payment CAPTCHA / fraud checks",
      "browser email verify loop for each site account",
    ],
    requiresOnce: [
      "One management/payer AWS account (human signup, long ago is fine)",
      "Organizations enabled on that account",
      "IAM permission organizations:CreateAccount + sts:AssumeRole on OrganizationAccountAccessRole",
    ],
    commands: {
      createMember:
        "aws-site-ship create-account --email you+site@example.com --name my-site --profile mgmt --json",
      oneShot:
        "aws-site-ship headless --create-account --email you@example.com --management-profile mgmt --dir ./fixtures/site --words forest lamp --website",
      phoneOtpOnly:
        "aws-site-ship onlinesim number --service amazon --cheapest --wait --json",
    },
    note:
      "onlinesim helps only the SMS OTP piece of a manual root flow. It does not clear AWS CAPTCHA. Prefer create-account.",
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  log.title("CAPTCHA bypass (supported path)");
  log.ok("Do not automate root signup CAPTCHA scrapers — they break and burn accounts.");
  log.blank();
  log.info("Real bypass: skip root signup entirely.");
  log.info("Use AWS Organizations CreateAccount on a management account you already have.");
  log.blank();
  console.log("  One-time human (management account):");
  console.log("    1. Own a normal AWS account (root done once, ages ago is fine)");
  console.log("    2. Enable Organizations in console");
  console.log("    3. IAM: organizations:CreateAccount + sts:AssumeRole on");
  console.log("       arn:aws:iam::*:role/OrganizationAccountAccessRole");
  log.blank();
  console.log("  Then 100% API / no CAPTCHA for every new site account:");
  log.dim("    " + payload.commands.createMember);
  log.dim("    " + payload.commands.oneShot);
  log.blank();
  log.title("If you still insist on root signup");
  log.warn("CAPTCHA + payment stay manual. Only phone OTP can be assisted:");
  log.dim("    " + payload.commands.phoneOtpOnly);
  log.blank();
  log.ok("Member accounts created via Organizations never hit root CAPTCHA.");
}
