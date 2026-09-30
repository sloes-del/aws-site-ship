import open from "open";
import { loadConfig } from "../config.js";
import { fail, log } from "../ui.js";

export async function openLastCommand(): Promise<void> {
  const cfg = loadConfig();
  const url = cfg.lastDeploy?.url;
  if (!url) {
    fail("No last deploy URL. Run deploy first.", 1);
  }
  log.info(`Opening ${url}`);
  await open(url);
}
