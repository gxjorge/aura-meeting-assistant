import { describe, expect, it } from 'vitest';
import { addMcpConnection, normalizeMcpConnections } from '../../src/shared/mcp-connections.js';
import { LEGACY_DOCS_MCP_CONNECTION, type McpConnection } from '../../src/shared/types.js';

const LEGACY_DEFAULT_CONNECTIONS: McpConnection[] = [LEGACY_DOCS_MCP_CONNECTION];

describe('MCP connections settings (legacy migration surface)', () => {
  it('keeps Microsoft Docs as the legacy built-in documentation source', () => {
    expect(LEGACY_DEFAULT_CONNECTIONS).toContainEqual({
      id: 'microsoft-docs',
      name: 'Microsoft Docs',
      status: 'connected',
      description: 'Used for technical documentation cards surfaced during meetings.',
      transport: 'builtin',
    });
  });

  it('adds a custom MCP connector with normalized URL metadata', () => {
    const result = addMcpConnection(LEGACY_DEFAULT_CONNECTIONS, {
      name: 'Team Docs',
      url: 'https://mcp.contoso.example/docs/',
      description: 'Internal documentation MCP',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(result.connection).toMatchObject({
      id: 'custom-team-docs-d008ce9f',
      name: 'Team Docs',
      url: 'https://mcp.contoso.example/docs',
      description: 'Internal documentation MCP',
      transport: 'http',
      status: 'configured',
    });
    expect(result.connections).toHaveLength(LEGACY_DEFAULT_CONNECTIONS.length + 1);
  });

  it('rejects invalid MCP URLs without changing the connection list', () => {
    const result = addMcpConnection(LEGACY_DEFAULT_CONNECTIONS, {
      name: 'Broken MCP',
      url: 'file:///tmp/mcp.sock',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid MCP URL to fail');
    expect(result.error).toContain('http');
    expect(result.connections).toEqual(LEGACY_DEFAULT_CONNECTIONS);
  });

  it('does not add duplicate MCP URLs', () => {
    const first = addMcpConnection(LEGACY_DEFAULT_CONNECTIONS, {
      name: 'Team Docs',
      url: 'https://mcp.contoso.example/docs/',
    });
    if (!first.ok) throw new Error(first.error);

    const duplicate = addMcpConnection(first.connections, {
      name: 'Team Docs Again',
      url: 'https://mcp.contoso.example/docs',
    });

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error('Expected duplicate MCP URL to fail');
    expect(duplicate.error).toContain('already configured');
    expect(duplicate.connections).toEqual(first.connections);
  });

  it('migrates the previous Microsoft Learn built-in source to Microsoft Docs', () => {
    const legacyConnection: McpConnection = {
      id: 'microsoft-learn',
      name: 'Microsoft Learn',
      status: 'connected',
      transport: 'builtin',
      description: 'Used for documentation cards surfaced during meetings.',
    };

    expect(normalizeMcpConnections([legacyConnection])).toEqual(LEGACY_DEFAULT_CONNECTIONS);
  });
});
