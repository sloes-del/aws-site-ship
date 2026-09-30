import open from "open";
import { confirm } from "@inquirer/prompts";
import { log } from "../ui.js";

const SIGNUP_URL =
  "https://signin.aws.amazon.com/signup?request_type=register";

export async function signupCommand(opts: {
  noOpen?: boolean;
}): Promise<void> {
  log.title("AWS root signup (browser — not fully headless)");
  log.warn(
    "Root registration still requires human email/phone/payment/CAPTCHA.",
  );
  log.info(
    "For 100% headless *member* accounts, use an existing management account:",
  );
  log.dim(
    "  aws-site-ship create-account --email you+site@example.com --name my-site",
  );
  log.dim(
    "  aws-site-ship headless --create-account --email you@example.com --dir ./dist --words hello world",
  );
  log.blank();

  console.log(`  ${SIGNUP_URL}`);
  log.blank();

  if (!opts.noOpen) {
    const should = await confirm({
      message: "Open root signup page in your browser?",
      default: true,
    });
    if (should) {
      await open(SIGNUP_URL);
      log.ok("Browser opened");
    }
  }

  log.title("Root checklist (manual once)");
  const steps = [
    "Root user email + AWS account name",
    "Verify email address",
    "Set root password",
    "Contact info + phone verification",
    "Payment method",
    "Enable AWS Organizations on this account (becomes management/payer)",
    "Create IAM admin (or use SSO) for the management account",
    "After that, all *member* accounts + deploys are headless via create-account / headless",
  ];
  for (const [i, s] of steps.entries()) {
    console.log(`  ${String(i + 1).padStart(2, " ")}. ${s}`);
  }

  log.blank();
  log.title("Skip CAPTCHA entirely (recommended)");
  log.ok("Do not fight root CAPTCHA — use Organizations member accounts:");
  log.dim("  aws-site-ship bypass-captcha");
  log.dim(
    "  aws-site-ship headless --create-account --email you@example.com --management-profile mgmt --dir ./dist --words forest lamp",
  );
  log.blank();
  log.title("Phone SMS helper only (onlinesim.io)");
  log.info(
    "If you still do manual root signup, OTP can use cheapest onlinesim country:",
  );
  log.dim("  set ONLINESIM_API_KEY=...   # https://onlinesim.io/v2/profile/ API tab");
  log.dim("  aws-site-ship onlinesim balance");
  log.dim(
    "  aws-site-ship onlinesim number --service amazon --cheapest --wait --json",
  );
  log.dim("  aws-site-ship onlinesim wait --tzid <id>   # if you skipped --wait");
  log.warn(
    "Root CAPTCHA + payment stay human. CAPTCHA bypass = create-account, not a solver.",
  );

  log.blank();
  log.info("Then: aws-site-ship auth -y   OR   aws-site-ship headless ...");
}
