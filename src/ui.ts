import chalk from "chalk";

export const log = {
  info: (msg: string) => console.log(chalk.cyan("ℹ"), msg),
  ok: (msg: string) => console.log(chalk.green("✔"), msg),
  warn: (msg: string) => console.log(chalk.yellow("⚠"), msg),
  err: (msg: string) => console.error(chalk.red("✖"), msg),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  title: (msg: string) => console.log("\n" + chalk.bold.white(msg)),
  blank: () => console.log(),
};

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function fail(message: string, code = 1): never {
  log.err(message);
  process.exit(code);
}
