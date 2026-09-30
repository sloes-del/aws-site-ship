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
  log.info("Then: aws-site-ship auth -y   OR   aws-site-ship headless ...");
}
