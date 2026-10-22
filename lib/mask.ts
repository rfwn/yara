// Shell output cleaning shared by the browser console and the server-side exec.
// Anything headed to the model goes through here first.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
const SECRET_NAME = "[A-Za-z_][\\w]*(?:SECRET|TOKEN|KEY|PASS|PWD|PRIVATE|DSN|_URL|_URI|CREDENTIAL)[\\w]*";
// KEY=value at the start of a line (env dumps, .env files).
const SECRET_LINE = new RegExp(`^(\\s*(?:export\\s+)?${SECRET_NAME})=(.*)$`, "gim");
// KEY=value anywhere else (echoed commands, inline assignments, URLs in args).
const SECRET_INLINE = new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|[^\\s;&|]+)`, "gi");
// Yara's end-of-command marker (see ConsolePane.run): the printf suffix and the marker line.
const MARKER = /;\s*printf '\\n%s%s_%s\\n' __YARA_ DONE_\w+ \$\?|^\s*__YARA_DONE_\w+_\d+\s*$/gm;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

export const stripYaraMarkers = (s: string) => s.replace(MARKER, "");

/** Strip terminal codes and Yara's markers, mask secret-looking assignments, keep the last `max` characters. */
export function cleanShellOutput(raw: string, max = 8000) {
  const clean = stripYaraMarkers(stripAnsi(raw))
    .replace(SECRET_LINE, "$1=•••• (hidden)")
    .replace(SECRET_INLINE, (m, key: string, value: string) => (value.startsWith("••••") ? m : `${key}=••••`))
    .replace(/\n{3,}/g, "\n\n");
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}
