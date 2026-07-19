// Silences Node's one-off "SQLite is an experimental feature" ExperimentalWarning
// so the CLI's output stays clean. node:sqlite is a deliberate, supported choice
// for this tool. Call this BEFORE anything links node:sqlite (see index.ts).

function warningText(warning: string | Error): string {
  return typeof warning === "string" ? warning : warning.message;
}

export function installSqliteWarningFilter(): void {
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    if (warningText(warning).includes("SQLite is an experimental feature")) return;
    (emitWarning as (w: string | Error, ...rest: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}
