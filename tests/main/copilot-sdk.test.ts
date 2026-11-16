import { describe, it, expect } from 'vitest';
import path from 'path';

// Skip if no GH auth available (CI)
const HAS_AUTH = !!process.env.GH_TOKEN || true; // assume local dev has gh auth

describe.skipIf(!HAS_AUTH)('Copilot SDK — agent sessions', () => {
  let client: unknown;
  let sdk: Record<string, unknown>;

  async function getTestClient() {
    if (client) return client as { createSession: Function; stop: Function };
    sdk = await import('@github/copilot-sdk') as Record<string, unknown>;
    const CopilotClient = sdk.CopilotClient as new (opts: unknown) => {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      createSession: (opts: unknown) => Promise<unknown>;
      listModels: () => Promise<Array<{ id: string }>>;
    };

    const nativeCli = path.join(
      process.cwd(), 'node_modules', '@github',
      `copilot-${process.platform}-${process.arch}`, 'copilot.exe'
    );

    const c = new CopilotClient({ logLevel: 'warning', cliPath: nativeCli });
    await c.start();
    client = c;
    return c;
  }

  it('sendAndWait returns a non-empty response', async () => {
    const c = await getTestClient();
    const session = await c.createSession({
      systemMessage: { mode: 'replace', content: 'Reply with one word only.' },
      onPermissionRequest: (sdk as Record<string, unknown>).approveAll,
    }) as { sendAndWait: Function; disconnect: Function };

    const result = await session.sendAndWait({ prompt: 'What is 2+2? Just the number.' }) as { data?: { content?: string } };
    await session.disconnect();

    expect(result?.data?.content).toBeTruthy();
    expect(result!.data!.content!.length).toBeGreaterThan(0);
    console.log('sendAndWait result:', result?.data?.content);
  }, 30_000);

  it('sendAndWait with 300s timeout handles longer responses', async () => {
    const c = await getTestClient();
    const session = await c.createSession({
      systemMessage: { mode: 'replace', content: 'You are a research agent. Provide detailed information.' },
      onPermissionRequest: (sdk as Record<string, unknown>).approveAll,
    }) as { sendAndWait: Function; disconnect: Function };

    // Use 300s timeout like the agent code does
    const result = await session.sendAndWait(
      { prompt: 'What are the key features of Node.js 22? Be concise.' },
      300_000,
    ) as { data?: { content?: string } };
    await session.disconnect();

    console.log('300s timeout result:', result?.data?.content?.slice(0, 100));
    expect(result?.data?.content).toBeTruthy();
    expect(result!.data!.content!.length).toBeGreaterThan(0);
  }, 120_000);
}, 120_000);
