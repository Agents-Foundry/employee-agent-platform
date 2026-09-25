// Creates a runtime workload key pair. The private key stays with the runtime; register the
// printed public key with the control plane (AGENT_RUNTIME_IDENTITIES_PATH).
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run keygen -- <private-key-output-path.pem>');
  process.exit(2);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      privateKeyPath: path,
      publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
    null,
    2,
  ),
);
