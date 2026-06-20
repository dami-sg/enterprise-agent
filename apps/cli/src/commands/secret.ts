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
      } else if (key.sequence && !key.ctrl) {
        buf += key.sequence;
        process.stderr.write('•');
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

function readPipedLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.split('\n', 1)[0]!.trim()));
  });
}
