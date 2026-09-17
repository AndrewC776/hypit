/**
 * Every string that leaves a process passes through here. The rules over-redact on purpose: a log
 * line that loses a harmless value costs nothing, a log line that keeps a live credential costs a
 * rotation. Two real exposures on this deployment shaped the list — an `sk-` key sitting in a
 * `KEY=value` shell line, and a cloudflared tunnel token passed as `--token eyJ...`.
 */
type RedactionRule = {
  readonly pattern: RegExp;
  readonly replacement: string;
};

const SECRET_KEY_WORD = "(?:token|secret|key|password|passwd|credential|authorization)";
const SECRET_KEY_NAME = `[A-Za-z0-9_.-]*${SECRET_KEY_WORD}[A-Za-z0-9_.-]*`;

/**
 * Order matters. The structured rules run first so a whole assignment collapses to one placeholder;
 * the loose token rules then catch a credential that appears bare in prose or in a stack trace.
 */
const RULES: readonly RedactionRule[] = [
  {
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/gu,
    replacement: "[REDACTED:private-key]",
  },
  {
    pattern: /\b(authorization|cf-access-client-secret|x-api-key)([ \t]*:[ \t]*)[^\r\n]+/giu,
    replacement: "$1$2[REDACTED:header]",
  },
  {
    // The unquoted value stops at `&` so a signed URL loses only the signed parameter and keeps
    // the rest of its query readable. A quoted value may contain `&`: nothing terminates it early.
    pattern: new RegExp(
      `(?<![A-Za-z0-9_.-])(${SECRET_KEY_NAME})([ \\t]*=[ \\t]*)`
      + `(?:"[^"\\r\\n]{8,}"|'[^'\\r\\n]{8,}'|[^\\s"'&\\r\\n]{8,})`,
      "giu",
    ),
    replacement: "$1$2[REDACTED:secret]",
  },
  {
    pattern: new RegExp(`("${SECRET_KEY_NAME}"[ \\t]*:[ \\t]*)"[^"\\r\\n]{8,}"`, "giu"),
    replacement: '$1"[REDACTED:secret]"',
  },
  {
    pattern: new RegExp(
      `(--[a-z0-9-]*${SECRET_KEY_WORD}[a-z0-9-]*[ \\t]+)(?:"[^"\\r\\n]{8,}"|'[^'\\r\\n]{8,}'|[^\\s\\r\\n]{8,})`,
      "giu",
    ),
    replacement: "$1[REDACTED:secret]",
  },
  {
    pattern: /([?&][A-Za-z0-9_.-]*(?:token|signature|sig|key|secret|credential|password)[A-Za-z0-9_.-]*=)[^&\s"'\r\n]+/giu,
    replacement: "$1[REDACTED:query]",
  },
  {
    // A cloudflared tunnel token is base64 JSON; a JWT is three dot-separated parts. Both start eyJ.
    pattern: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_=-]+){0,2}/gu,
    replacement: "[REDACTED:jwt]",
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/gu, replacement: "[REDACTED:api-key]" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/gu, replacement: "[REDACTED:github-token]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/gu, replacement: "[REDACTED:aws-access-key-id]" },
];

export function redact(text: string): string {
  let output = text;
  for (const rule of RULES) {
    output = output.replace(rule.pattern, rule.replacement);
  }
  return output;
}

/**
 * A filesystem root to hide. `path` is an absolute directory; `as` is the label that replaces it,
 * e.g. `{ path: "/Users/someone/hypit-work/jobs/vid_.../project", as: "<workspace>" }`.
 */
export type PathRoot = {
  readonly path: string;
  readonly as: string;
};

const REGEX_META = /[.*+?^${}()|[\]\\]/gu;

function escapeRegex(value: string): string {
  return value.replace(REGEX_META, "\\$&");
}

/**
 * Hypit execution-log records carry URL-encoded absolute paths in their `command` field, so a
 * plain string replacement misses them. Match each character in either its literal or its
 * percent-encoded form, which covers `/Users/...`, `%2FUsers%2F...` and any mixture of the two.
 */
function rootPattern(path: string): RegExp {
  const parts: string[] = [];
  for (const char of path) {
    if (char === "/" || char === "\\") {
      parts.push("(?:[/\\\\]|%2f|%5c)");
      continue;
    }
    let encoded = char;
    try {
      encoded = encodeURIComponent(char);
    } catch {
      // A lone surrogate cannot be encoded; matching its literal form is still correct.
    }
    parts.push(encoded === char ? escapeRegex(char) : `(?:${escapeRegex(char)}|${escapeRegex(encoded)})`);
  }
  return new RegExp(parts.join(""), "giu");
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[/\\]+$/u, "");
}

/**
 * Replace every occurrence of a known root with its label, so an external caller learns the shape
 * of a path without learning the host's user name or directory layout. Longer roots win, so a job
 * workspace nested inside the home directory is labelled as the workspace, not as the home.
 */
export function relativizePaths(text: string, roots: readonly PathRoot[]): string {
  const ordered = [...roots]
    .map((root) => ({ path: trimTrailingSeparators(root.path), as: root.as }))
    .filter((root) => root.path !== "")
    .sort((left, right) => right.path.length - left.path.length);
  let output = text;
  for (const root of ordered) {
    output = output.replace(rootPattern(root.path), () => root.as);
  }
  return output;
}
