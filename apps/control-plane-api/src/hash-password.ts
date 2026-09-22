import { hashPassword } from './passwords.js';

// Read stdin, never command-line arguments (which can be recorded in shell history).
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 1024) throw new Error('Password input too long');
}
try {
  console.log(await hashPassword(input.replace(/\r?\n$/, '')));
} catch {
  console.error('Provide a password of 15–256 characters via standard input.');
  process.exitCode = 1;
}
