/* What the code map may show of a config value. A secret-looking key (…KEY, TOKEN, SECRET, PASSWORD, AUTH, …) or a
   credential-shaped value (a URL with a password, a private key block, a JWT, a provider token, a long random
   string) is shown only as set. */
export const REDACTED = 'set (redacted)';
const SECRET_KEY = /KEY|TOKEN|SECRET|PASS(WORD|WD|PHRASE)?|PWD|CREDENTIAL|PRIVATE|AUTH|CERT|SIGNATURE|SALT|COOKIE|SESSION|DSN/i;
const CREDENTIAL = [
  /^[a-z][\w+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i,          // scheme://user:password@host
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /^eyJ[\w-]+\.[\w-]+\./,                              // JWT
  /^(sk|pk|rk)[-_]\w[\w-]{15,}$/, /^(gh[pousr]|github_pat)_\w{20,}$/, /^xox[abposr]-/, /^AKIA[0-9A-Z]{16}$/, /^AIza[\w-]{30,}$/,
  /^Bearer\s+\S/i,
  /^[0-9a-f]{32,}$/i,
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/=_-]{32,}$/,
];
export const shownValue = (key, value) =>
  value == null ? value : SECRET_KEY.test(key || '') || CREDENTIAL.some(re => re.test(String(value))) ? REDACTED : value;
