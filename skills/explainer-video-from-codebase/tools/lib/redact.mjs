/* Redact credential-shaped strings from what a traced test run printed, before trace.mjs writes it to trace.log, shows
   its tail or keeps a failure message in trace.json: private-key blocks, AWS access key ids, bearer and basic auth
   headers, well-known token formats, JWTs, a URL's password, and the value of any key=value or "key": "value" whose
   key names a secret (password, secret, token, api key, credential, ...). The secret is replaced, its label kept. */
export const REDACTED = '[REDACTED]';

// a key that names a secret (`db_password`, `API_KEY`, `x-auth-token`), but not `author` or `tokenizer.py`
const SECRET_KEY = String.raw`[A-Za-z0-9_-]*(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|auth(?![a-z]))[A-Za-z0-9_-]*`;

const RULES = [
  // a private key block, or its first line when the output was cut short
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$(?![\s\S]))/g, `-----BEGIN $1PRIVATE KEY----- ${REDACTED}`],
  [/(\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${REDACTED}@`],
  // "key": "value" and key: 'value'
  [new RegExp(String.raw`(["']?\b${SECRET_KEY}["']?\s*[:=](?![:=])\s*)(["'])(?:(?!\2)[^\\\n]|\\.)+\2`, 'gi'), `$1$2${REDACTED}$2`],
  // key=value, key: value (unquoted, to the end of the word)
  [new RegExp(String.raw`(\b${SECRET_KEY}\s*[:=](?![:=])\s*)(?!["'\s]|\[REDACTED\]|(?:Bearer|Basic|Token)\s)[^\s,;&'"}\])]+`, 'gi'), `$1${REDACTED}`],
  [/\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36})\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const [re, by] of RULES) s = s.replace(re, by);
  return s;
}
