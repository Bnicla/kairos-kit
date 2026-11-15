/**
 * The environment a helper program (LibreOffice, poppler, a version check) is
 * started with: what it needs to run, and nothing else.
 *
 * A started program gets a copy of the starter's environment unless told
 * otherwise. Under the hosted connector that environment holds the key for
 * sealed tokens and the Google client's secret, and LibreOffice reads files a
 * user can influence. So every helper is started with this short list.
 */
const KEPT = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SystemRoot"];

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of KEPT) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
