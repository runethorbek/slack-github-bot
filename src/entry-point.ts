// Process concerns shared by the two entry points (PLAN.md §2 design rule 4):
// `node src/main.ts` and `node src/attention-summary.ts`.
//
// Each entry point has a `main(environment, deps)` that resolves to the exit
// code. `runEntryPoint` adds the top-level error handler: an error that escapes
// `main` is reported as exactly one secret-free line on stderr (security
// invariant S7) and gives exit code 1, as an uncaught Python exception does.
// `runProcess` is what the real process runs; `entryPointMode` is the
// `import.meta.main` guard.
//
// Each entry point passes its own list of error classes whose messages are
// application-defined and secret-free; only those messages are printed.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** An error class whose instances' messages the top-level handler may print. */
export type SecretFreeMessageError = abstract new (...args: never[]) => Error;

/**
 * The one line the top-level handler prints for an uncaught error: the error's
 * name, plus its message for an error of one of `secretFreeMessageErrors`.
 * Never a stack, a cause chain, a URL or a body (security invariant S7).
 */
export function uncaughtErrorLine(
  error: unknown,
  secretFreeMessageErrors: readonly SecretFreeMessageError[],
): string {
  let name = "Error";
  let message: string | null = null;
  try {
    if (error instanceof Error) {
      if (typeof error.name === "string" && /^[A-Za-z_$][\w$]*$/.test(error.name)) {
        name = error.name;
      }
      if (secretFreeMessageErrors.some((errorClass) => error instanceof errorClass)) {
        message = String(error.message).replace(/[\r\n\u2028\u2029]+/g, " ");
      }
    }
  } catch {
    // A hostile getter must not stop the report.
  }
  return message ? `${name}: ${message}` : name;
}

export type WriteStderr = (text: string) => void;

export function writeToStderr(text: string): void {
  process.stderr.write(text);
}

/** Python's `print(line)`: the line plus "\n" on stdout. */
export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * `sys.exit(main())` with the top-level error handler: an error escaping main
 * is reported as one secret-free line on stderr and resolves to exit code 1.
 */
export async function runEntryPoint(
  main: () => Promise<number>,
  secretFreeMessageErrors: readonly SecretFreeMessageError[],
  writeStderr: WriteStderr = writeToStderr,
): Promise<number> {
  try {
    return await main();
  } catch (error) {
    writeStderr(`${uncaughtErrorLine(error, secretFreeMessageErrors)}\n`);
    return 1;
  }
}

/**
 * Run as the process: runEntryPoint, then `process.exitCode`. Anything that
 * escapes the awaited chain (an unhandled rejection becomes an uncaught
 * exception) gets the same one-line report instead of Node's default output,
 * which prints the stack and any cause chain. Once that has happened the exit
 * code stays 1, whatever main resolves to.
 */
export async function runProcess(
  main: () => Promise<number>,
  secretFreeMessageErrors: readonly SecretFreeMessageError[],
  writeStderr: WriteStderr = writeToStderr,
): Promise<void> {
  let uncaught = false;
  process.on("uncaughtException", (error) => {
    uncaught = true;
    writeStderr(`${uncaughtErrorLine(error, secretFreeMessageErrors)}\n`);
    process.exitCode = 1;
  });
  const exitCode = await runEntryPoint(main, secretFreeMessageErrors, writeStderr);
  process.exitCode = uncaught ? 1 : exitCode;
}

/** The one stderr line when Node cannot tell whether this module is the entry point. */
export const UNSUPPORTED_NODE_MESSAGE = "This entry point requires Node.js >= 24.2 (import.meta.main).";

/**
 * Whether a module is being run as the program ("run"), imported ("imported"),
 * or run on a Node without `import.meta.main` (before 24.2, "unsupported").
 * There `import.meta.main` is undefined, so a plain guard would silently do
 * nothing and exit 0; when the module is the script Node was started with
 * (`argvScript`, process.argv[1]), that must fail loudly instead.
 */
export function entryPointMode(
  importMetaMain: unknown,
  argvScript: string | undefined,
  moduleUrl: string,
): "run" | "imported" | "unsupported" {
  if (importMetaMain === true) return "run";
  if (importMetaMain !== undefined || argvScript === undefined) return "imported";
  return path.resolve(argvScript) === fileURLToPath(moduleUrl) ? "unsupported" : "imported";
}

/**
 * The module-level guard: run `run` when the module is the program; fail
 * loudly on a Node without `import.meta.main`; do nothing when imported.
 */
export async function runIfEntryPoint(
  importMeta: { main?: unknown; url: string },
  run: () => Promise<void>,
): Promise<void> {
  const mode = entryPointMode(importMeta.main, process.argv[1], importMeta.url);
  if (mode === "run") {
    await run();
  } else if (mode === "unsupported") {
    writeToStderr(`${UNSUPPORTED_NODE_MESSAGE}\n`);
    process.exitCode = 1;
  }
}
