import assert from 'node:assert/strict';

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotpStep,
  otpauthUri,
  totpCode,
  totpStep,
} from '../totp.js';

/**
 * The TOTP service against what its standards publish: RFC 4226's HOTP table,
 * RFC 6238's SHA-1 table, and RFC 4648's base32 vectors. If an app and EPM ever
 * disagree about a code, this is where the argument is settled.
 *
 * No stack needed: `npx tsx src/auth/__checks__/totp.check.ts`.
 */

// RFC 4648 §10.
for (const [plain, encoded] of [
  ['', ''],
  ['f', 'MY'],
  ['fo', 'MZXQ'],
  ['foo', 'MZXW6'],
  ['foob', 'MZXW6YQ'],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI'],
] as const) {
  assert.equal(base32Encode(Buffer.from(plain)), encoded, `base32 of "${plain}"`);
  assert.equal(base32Decode(encoded).toString(), plain, `from base32 "${encoded}"`);
}
assert.equal(base32Decode('mzxw 6ytb oi==').toString(), 'foobar', 'decoding forgives case, spaces and padding');
assert.throws(() => base32Decode('MZXW1'), /base32/, '1 is not in the alphabet');

// RFC 4226 appendix D: the secret "12345678901234567890", counters 0 to 9.
const rfcSecret = Buffer.from('12345678901234567890');
for (const [counter, expected] of [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
].entries()) {
  assert.equal(hotp(rfcSecret, counter), expected, `RFC 4226 counter ${counter}`);
}

// RFC 6238 appendix B, SHA-1, eight digits.
const rfcBase32 = base32Encode(rfcSecret);
for (const [seconds, expected] of [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
] as const) {
  assert.equal(totpCode(rfcBase32, totpStep(seconds * 1000), 8), expected, `RFC 6238 at ${seconds}`);
}

// Matching: now and one step either side, nothing further.
const secret = generateTotpSecret();
assert.match(secret, /^[A-Z2-7]{32}$/, 'a new secret is 160 bits of base32');
assert.notEqual(generateTotpSecret(), secret, 'and is not the same one twice');

const now = 1_800_000_000_000;
const step = totpStep(now);
assert.equal(matchTotpStep(secret, totpCode(secret, step), now), step, 'this step');
assert.equal(matchTotpStep(secret, totpCode(secret, step - 1), now), step - 1, 'the step before');
assert.equal(matchTotpStep(secret, totpCode(secret, step + 1), now), step + 1, 'the step after');
for (const away of [-3, -2, 2, 3]) {
  const code = totpCode(secret, step + away);
  // A code can repeat by chance; only treat this as a refusal when it truly differs.
  const inWindow = [-1, 0, 1].some((offset) => totpCode(secret, step + offset) === code);
  if (!inWindow) assert.equal(matchTotpStep(secret, code, now), null, `${away} steps away`);
}

// Not a code at all.
for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
  assert.equal(matchTotpStep(secret, bad, now), null, `"${bad}" is not a code`);
}

// The address apps read.
const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Intertec EPM', account: 'a.person@example.com' });
assert.equal(
  uri,
  'otpauth://totp/Intertec%20EPM:a.person%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Intertec%20EPM&algorithm=SHA1&digits=6&period=30',
);

console.log('totp check passed: RFC 4648, RFC 4226 and RFC 6238 vectors, the drift window, malformed codes and the otpauth address');
