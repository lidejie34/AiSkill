/**
 * 仅在有 --verbose 时输出；入口处需先调用 stripVerboseArg() 并 setVerbose()。
 */

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function isVerbose(): boolean {
  return verbose;
}

/** 从 process.argv 移除 --verbose，避免被后续参数解析使用 */
export function stripVerboseArg(): boolean {
  const i = process.argv.indexOf("--verbose");
  if (i === -1) return false;
  process.argv.splice(i, 1);
  return true;
}

export function logVerbose(...args: unknown[]): void {
  if (verbose) console.log(...args);
}
