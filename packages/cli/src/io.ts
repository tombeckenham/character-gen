import { stdout as output } from "node:process";

/** Writes a line to stdout (command results). */
export function out(line: string): void {
  output.write(`${line}\n`);
}

/** Writes a line to stderr (progress and errors). */
export function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** True when the arg list requests command help. */
export function wantsHelp(rest: string[]): boolean {
  return rest.includes("--help") || rest.includes("-h");
}
