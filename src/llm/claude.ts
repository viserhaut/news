const CLAUDE_TIMEOUT_MS = 180_000;

export class ClaudeAuthError extends Error {
  constructor() {
    super("Claude CLI: not authenticated. Run `claude` to log in.");
    this.name = "ClaudeAuthError";
  }
}

/**
 * Claude Code CLI を Bun.spawn で呼び出す。
 * セキュリティ: プロンプトは stdin 経由で渡す。シェル引数に展開しない。
 */
export async function callClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn(["claude", "--print"], {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, CLAUDE_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);

    const stderrText = stderr.toLowerCase();
    if (
      stderrText.includes("not logged in") ||
      stderrText.includes("authentication") ||
      stderrText.includes("unauthorized") ||
      stderrText.includes("login")
    ) {
      throw new ClaudeAuthError();
    }

    if (exitCode !== 0) {
      throw new Error(`Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 200)}`);
    }

    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(total);
}
