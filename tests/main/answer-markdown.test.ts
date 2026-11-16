import { describe, expect, it } from 'vitest';
import { parseAnswerMarkdown } from '../../src/shared/answer-markdown.js';

describe('answer markdown parsing', () => {
  it('turns common answer markdown into display blocks', () => {
    const blocks = parseAnswerMarkdown(`# Recommendation

- **Use Azure AI Foundry** for agents.
- Open [Microsoft Docs](https://learn.microsoft.com/azure/ai-foundry/).

\`\`\`ts
const model = 'gpt-4o';
\`\`\``);

    expect(blocks).toEqual([
      {
        type: 'heading',
        level: 1,
        content: [{ type: 'text', text: 'Recommendation' }],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          [
            {
              type: 'strong',
              content: [{ type: 'text', text: 'Use Azure AI Foundry' }],
            },
            { type: 'text', text: ' for agents.' },
          ],
          [
            { type: 'text', text: 'Open ' },
            {
              type: 'link',
              url: 'https://learn.microsoft.com/azure/ai-foundry',
              content: [{ type: 'text', text: 'Microsoft Docs' }],
            },
            { type: 'text', text: '.' },
          ],
        ],
      },
      {
        type: 'code',
        language: 'ts',
        text: "const model = 'gpt-4o';",
      },
    ]);
  });

  it('turns markdown tables into table blocks with formatted cells', () => {
    const blocks = parseAnswerMarkdown(`| Feature | Status | Reference |
| --- | --- | --- |
| Copilot coding agent | **Available** | [GitHub Docs](https://docs.github.com/en/copilot) |
| GitHub Models | Preview | \`models.github.ai\` |`);

    expect(blocks).toEqual([
      {
        type: 'table',
        headers: [
          [{ type: 'text', text: 'Feature' }],
          [{ type: 'text', text: 'Status' }],
          [{ type: 'text', text: 'Reference' }],
        ],
        rows: [
          [
            [{ type: 'text', text: 'Copilot coding agent' }],
            [{ type: 'strong', content: [{ type: 'text', text: 'Available' }] }],
            [
              {
                type: 'link',
                url: 'https://docs.github.com/en/copilot',
                content: [{ type: 'text', text: 'GitHub Docs' }],
              },
            ],
          ],
          [
            [{ type: 'text', text: 'GitHub Models' }],
            [{ type: 'text', text: 'Preview' }],
            [{ type: 'code', text: 'models.github.ai' }],
          ],
        ],
      },
    ]);
  });
});
