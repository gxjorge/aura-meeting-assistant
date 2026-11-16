import type { AnswerMarkdownBlock, AnswerMarkdownInline } from '../../shared/answer-markdown';
import { parseAnswerMarkdown } from '../../shared/answer-markdown';

interface AnswerMarkdownProps {
  markdown: string;
}

export default function AnswerMarkdown({ markdown }: AnswerMarkdownProps) {
  const blocks = parseAnswerMarkdown(markdown);

  return (
    <div className="answer-markdown">
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: AnswerMarkdownBlock, index: number) {
  if (block.type === 'heading') {
    return (
      <h3 key={index} className={`answer-markdown-heading answer-markdown-heading-${block.level}`}>
        {renderInline(block.content)}
      </h3>
    );
  }

  if (block.type === 'paragraph') {
    return <p key={index}>{renderInline(block.content)}</p>;
  }

  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item)}</li>
        ))}
      </Tag>
    );
  }

  if (block.type === 'table') {
    return (
      <div key={index} className="answer-markdown-table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex}>{renderInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.type === 'quote') {
    return <blockquote key={index}>{renderInline(block.content)}</blockquote>;
  }

  if (block.type === 'code') {
    return (
      <pre key={index}>
        <code>{block.text}</code>
      </pre>
    );
  }

  return <hr key={index} />;
}

function renderInline(nodes: AnswerMarkdownInline[]) {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'strong') return <strong key={index}>{renderInline(node.content)}</strong>;
    if (node.type === 'code') return <code key={index}>{node.text}</code>;

    return (
      <a
        key={index}
        href={node.url}
        onClick={(event) => {
          event.preventDefault();
          window.aura.openExternalUrl(node.url);
        }}
      >
        {renderInline(node.content)}
      </a>
    );
  });
}
