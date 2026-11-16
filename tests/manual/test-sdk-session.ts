/**
 * Detailed SDK session test — captures ALL events to understand timing and content.
 * Run with: npx tsx tests/manual/test-sdk-session.ts
 */
import path from 'path';

async function main() {
  const sdk = await import('@github/copilot-sdk');
  const nativeCli = path.join(
    process.cwd(), 'node_modules', '@github',
    `copilot-${process.platform}-${process.arch}`, 'copilot.exe'
  );

  console.log('[Test] Starting client...');
  const client = new sdk.CopilotClient({ logLevel: 'warning', cliPath: nativeCli });
  await client.start();

  const models = await client.listModels();
  const modelIds = models.map((m: { id?: string }) => m.id).filter(Boolean);
  console.log(`[Test] Models: ${modelIds.slice(0, 5).join(', ')}`);

  // Test: Full event trace with a real question
  console.log('\n=== Test: Full event trace with sendAndWait ===');
  {
    const session = await client.createSession({
      model: 'claude-sonnet-4.6',
      systemMessage: { mode: 'replace', content: 'You are a research assistant. Provide a helpful, detailed answer.' },
      onPermissionRequest: sdk.approveAll,
    }) as Record<string, Function>;

    // Listen to ALL events
    for (const evt of ['assistant.message_delta', 'assistant.message', 'session.idle', 'session.error']) {
      session.on(evt, (e: unknown) => {
        const data = (e as Record<string, unknown>).data as Record<string, unknown> | undefined;
        if (evt === 'assistant.message_delta') {
          process.stdout.write('.');
        } else {
          const contentLen = typeof data?.content === 'string' ? data.content.length : 0;
          const deltaLen = typeof data?.deltaContent === 'string' ? data.deltaContent.length : 0;
          console.log(`\n  [EVENT] ${evt}: content=${contentLen} delta=${deltaLen}`);
        }
      });
    }

    console.log('[Test] Sending question...');
    const start = Date.now();
    const result = await session.sendAndWait({ prompt: 'What are the main differences between TypeScript and JavaScript? Be concise, 2-3 sentences.' });
    const elapsed = Date.now() - start;
    const content = (result as { data?: { content?: string } })?.data?.content ?? '';
    console.log(`[Test] sendAndWait returned in ${elapsed}ms: ${content.length} chars`);
    console.log(`[Test] Content: "${content.slice(0, 200)}"`);
    await (session as Record<string, Function>).disconnect();
  }

  // Test: Longer question — use streaming to avoid sendAndWait 60s timeout
  console.log('\n=== Test: Longer question with streaming (no sendAndWait) ===');
  {
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.log(`\n  [TIMEOUT] deltaCount=${deltaCount}, deltaChars=${deltaChars}`);
        reject(new Error('Timeout 120s'));
      }, 120_000);

      let deltaCount = 0;
      let deltaChars = 0;

      (async () => {
        const session = await client.createSession({
          model: 'claude-sonnet-4.6',
          streaming: true,
          systemMessage: { mode: 'replace', content: 'You are a research agent. Provide detailed information.' },
          onPermissionRequest: sdk.approveAll,
        }) as Record<string, Function>;

        session.on('assistant.message_delta', (e: { data: { deltaContent: string } }) => {
          if (e.data.deltaContent) {
            deltaCount++;
            deltaChars += e.data.deltaContent.length;
            if (deltaCount % 20 === 0) process.stdout.write('.');
          }
        });

        session.on('assistant.message', (e: { data: { content: string } }) => {
          clearTimeout(timer);
          const content = e.data.content || '';
          console.log(`\n  [DONE] ${content.length} chars, ${deltaCount} deltas, ${deltaChars} delta chars`);
          session.disconnect().catch(() => {});
          resolve(content || `(empty event, but ${deltaChars} delta chars accumulated)`);
        });

        const start = Date.now();
        await session.send({ prompt: 'Research and provide detailed information about: What is the latest Node.js LTS version and its key features?' });
        console.log(`  [SENT] in ${Date.now() - start}ms, waiting for response...`);
      })().catch(reject);
    });
    console.log(`[Test] Result: ${result.length} chars`);
    console.log(`[Test] Preview: "${result.slice(0, 300)}"`);
  }

  await client.stop();
  console.log('\nAll tests done');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
