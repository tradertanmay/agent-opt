import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/i,
  /(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json|secrets\.json|\.npmrc|\.pypirc)$/i,
];

const SECRET_REGEXES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'ANTHROPIC_KEY', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'OPENAI_KEY', pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9]{20,}\b/g },
  { name: 'AWS_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GITHUB_TOKEN', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: 'PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'GENERIC_SECRET_ASSIGNMENT',
    pattern:
      /\b((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*['"])([^'"]{8,})(['"])/gi,
  },
];

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules)/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules)/gi,
  /system\s+override\s*:/gi,
  /new\s+system\s+instructions\s*:/gi,
  /you\s+are\s+now\s+in\s+developer\s+mode/gi,
  /<\s*\/?\s*(?:system|instruction|assistant|user|tool_call)\s*>/gi,
];

/**
 * Checks if a file path matches sensitive secret/credential file patterns that must never be indexed or injected.
 */
export function isSensitiveFilePath(relOrAbsPath: string): boolean {
  const normalized = relOrAbsPath.split(path.sep).join('/');
  const base = path.posix.basename(normalized);
  for (const pat of SENSITIVE_FILE_PATTERNS) {
    if (pat.test(base) || pat.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Redacts credentials/secrets and neutralizes prompt-injection payloads from any text
 * before it is injected into agent context or persisted in logs.
 */
export function sanitizeContextText(input: string): {
  sanitized: string;
  redactedSecretsCount: number;
  neutralizedInjectionsCount: number;
} {
  if (!input) {
    return { sanitized: '', redactedSecretsCount: 0, neutralizedInjectionsCount: 0 };
  }

  let out = input;
  let redactedSecretsCount = 0;
  let neutralizedInjectionsCount = 0;

  for (const { name, pattern } of SECRET_REGEXES) {
    out = out.replace(pattern, (...args) => {
      redactedSecretsCount += 1;
      if (name === 'GENERIC_SECRET_ASSIGNMENT') {
        return `${args[1]}[REDACTED_${name}]${args[3]}`;
      }
      return `[REDACTED_${name}]`;
    });
  }

  for (const injPattern of PROMPT_INJECTION_PATTERNS) {
    out = out.replace(injPattern, () => {
      neutralizedInjectionsCount += 1;
      return '[SANITIZED_UNTRUSTED_DIRECTIVE]';
    });
  }

  return {
    sanitized: out,
    redactedSecretsCount,
    neutralizedInjectionsCount,
  };
}

/**
 * Writes a JSON file atomically using a process-unique temporary file + renameSync
 * so concurrent agent sessions never corrupt shared or session JSON state.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const uniqueSuffix = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const tmpPath = `${filePath}.tmp.${uniqueSuffix}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
