import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP scrypt profile: N=2^15, r=8, p=3. Fixed parameters prevent untrusted cost selection.
export const passwordHashPattern = /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, 'hex'),
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
export async function hashPassword(password: string): Promise<string> {
  if ([...password].length < 15 || password.length > 256)
    throw new Error('Use a password of 15–256 characters.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$8$3$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash?: string): Promise<boolean> {
  const valid = !!hash && passwordHashPattern.test(hash);
  const parts = valid ? hash!.split('$') : [];
  // Unknown accounts still perform the same expensive derivation.
  const key = await derive(password, parts[4] ?? '00'.repeat(16));
  return timingSafeEqual(key, Buffer.from(parts[5] ?? '00'.repeat(64), 'hex')) && valid;
}
