/**
 * Masked secret input (cli §10): the only place plaintext keys are touched.
 * Three rules — masked input, never echoed, never logged. A TTY reads with the
 * terminal echo disabled; a pipe (`echo $KEY | ea auth login`) reads the line
 * directly. The value flows straight into `KeyStore.set` and nowhere else.
 */
import { emitKeypressEvents } from 'node:readline';

export async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;

  // Non-interactive: consume one line from the pipe.
  if (!stdin.isTTY) {
    return await readPipedLine();
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
        // Printable input only — an arrow/function key delivers an escape
        // sequence (e.g. `\x1b[A`); appending it would silently corrupt the key.
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

/** True for a sequence of only printable characters (no control / escape bytes),
 *  so pasted keys pass but arrow/function-key escape sequences are rejected. */
function isPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function readPipedLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.split('\n', 1)[0]!.trim()));
    // Without this an aborted/broken pipe would leave `readSecret` pending forever.
    process.stdin.on('error', reject);
  });
}
