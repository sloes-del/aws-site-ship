import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type AwsResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type AwsRunOptions = {
  profile?: string;
  region?: string;
  /** Extra env merged into process.env */
  env?: Record<string, string>;
  /** If true, throw when exit code !== 0 */
  throwOnFail?: boolean;
};

function winQuote(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/g.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Resolve aws executable on PATH (prefers aws.exe, then aws.cmd). */
function resolveAwsBin(): string {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const names =
    process.platform === "win32"
      ? ["aws.exe", "aws.cmd", "aws.bat", "aws"]
      : ["aws"];

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return process.platform === "win32" ? "aws.cmd" : "aws";
}

const AWS_BIN = resolveAwsBin();

/**
 * Run AWS CLI. On Windows, .cmd shims are invoked through cmd.exe without shell:true.
 */
export function runAws(
  args: string[],
  opts: AwsRunOptions = {},
): Promise<AwsResult> {
  const finalArgs = [...args];
  if (opts.profile) finalArgs.push("--profile", opts.profile);
  if (opts.region) finalArgs.push("--region", opts.region);

  const isWinCmd =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(AWS_BIN);

  return new Promise((resolve, reject) => {
    const child = isWinCmd
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [AWS_BIN, ...finalArgs].map(winQuote).join(" ")],
          {
            env: { ...process.env, ...opts.env },
            windowsHide: true,
            shell: false,
          },
        )
      : spawn(AWS_BIN, finalArgs, {
          env: { ...process.env, ...opts.env },
          windowsHide: true,
          shell: false,
        });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn AWS CLI (${AWS_BIN}): ${err.message}. Is aws in PATH?`,
        ),
      );
    });
    child.on("close", (code) => {
      const result: AwsResult = {
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (opts.throwOnFail && result.code !== 0) {
        reject(
          new Error(
            `aws ${finalArgs.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

export async function awsVersion(): Promise<string | null> {
  try {
    const r = await runAws(["--version"]);
    if (r.code !== 0) return null;
    return r.stdout || r.stderr || null;
  } catch {
    return null;
  }
}

export async function getCallerIdentity(
  profile?: string,
  region?: string,
): Promise<{ Account: string; Arn: string; UserId: string }> {
  const r = await runAws(
    ["sts", "get-caller-identity", "--output", "json"],
    { profile, region, throwOnFail: true },
  );
  return JSON.parse(r.stdout) as {
    Account: string;
    Arn: string;
    UserId: string;
  };
}

export async function ssoLogin(profile: string): Promise<AwsResult> {
  return runAws(["sso", "login", "--profile", profile], { throwOnFail: false });
}

export async function configureSet(
  key: string,
  value: string,
  profile: string,
): Promise<void> {
  await runAws(
    ["configure", "set", key, value, "--profile", profile],
    { throwOnFail: true },
  );
}
