/**
 * Masked secret input for `ea-gateway secret set` (gateway §7). Mirrors the CLI's
 * three rules — masked input, never echoed, never logged. A TTY reads with echo
 * disabled (shown as •); a pipe (`echo $TOKEN | ea-gateway secret set <ref>`)
 * consumes one line. The value flows straight into `KeyStore.set` and nowhere else.
 */
import { emitKeypressEvents } from 'node:readline';

export async function readSecretInput(promptText: string): Promise<string> {
  const stdin = process.stdin;

  // Non-interactive: consume one line from the pipe.
  if (!stdin.isTTY) {
    return await new Promise<string>((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.split('\n', 1)[0]!.trim()));
      stdin.on('error', reject);
    });
  }

  process.stderr.write(promptText);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve) => {
    let buf = '';
    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        process.stderr.write('\n');
        resolve(buf);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stderr.write('\n');
        process.exit(130);
      } else if (key.name === 'backspace') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (key.sequence && !key.ctrl && isPrintable(key.sequence)) {
        buf += key.sequence;
        process.stderr.write('•'.repeat(key.sequence.length));
      }
    };
    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('keypress', onKey);
  });
}

function isPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}
