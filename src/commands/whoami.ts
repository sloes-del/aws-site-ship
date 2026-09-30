import { resolveIdentity } from "../aws/credentials.js";
import { log, printJson } from "../ui.js";

export async function whoamiCommand(opts: {
  profile?: string;
  region?: string;
  json?: boolean;
}): Promise<void> {
  const identity = await resolveIdentity({
    profile: opts.profile,
    region: opts.region,
    trySso: true,
  });

  if (opts.json) {
    printJson(identity);
    return;
  }

  log.title("AWS identity");
  log.ok(`Account  ${identity.account}`);
  log.ok(`ARN      ${identity.arn}`);
  log.ok(`UserId   ${identity.userId}`);
  log.ok(`Profile  ${identity.profile}`);
  log.ok(`Region   ${identity.region}`);
}
