import type { McpConnection } from './types.js';
import { LEGACY_DOCS_MCP_CONNECTION } from './types.js';

export interface AddMcpConnectionInput {
  name: string;
  url: string;
  description?: string;
}

export type AddMcpConnectionResult =
  | {
      ok: true;
      connections: McpConnection[];
      connection: McpConnection;
    }
  | {
      ok: false;
      connections: McpConnection[];
      error: string;
    };

export function addMcpConnection(
  connections: McpConnection[],
  input: AddMcpConnectionInput,
): AddMcpConnectionResult {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, connections, error: 'MCP name is required.' };
  }

  const normalizedUrl = normalizeMcpUrl(input.url);
  if (!normalizedUrl) {
    return { ok: false, connections, error: 'MCP URL must be an http or https URL.' };
  }

  const duplicate = connections.some((connection) => (
    connection.url ? normalizeMcpUrl(connection.url) === normalizedUrl : false
  ));
  if (duplicate) {
    return { ok: false, connections, error: 'That MCP URL is already configured.' };
  }

  const description = input.description?.trim();
  const connection: McpConnection = {
    id: `custom-${slugify(name)}-${stableHash(normalizedUrl)}`,
    name,
    url: normalizedUrl,
    status: 'configured',
    transport: 'http',
    ...(description ? { description } : {}),
  };

  return {
    ok: true,
    connections: [...connections, connection],
    connection,
  };
}

export function normalizeMcpConnections(connections: readonly McpConnection[]): McpConnection[] {
  const defaultDocsConnection = LEGACY_DOCS_MCP_CONNECTION;
  const normalized = connections
    .map((connection): McpConnection | null => {
      if (connection.id === 'microsoft-learn' || connection.name === 'Microsoft Learn') {
        return defaultDocsConnection;
      }

      if (!connection.name || !connection.id) return null;

      const isBuiltIn = connection.transport === 'builtin';
      const normalizedUrl = connection.url ? normalizeMcpUrl(connection.url) : '';
      if (!isBuiltIn && !normalizedUrl) return null;

      const status = connection.status === 'connected' || connection.status === 'error'
        ? connection.status
        : 'configured';

      return {
        ...connection,
        status,
        transport: isBuiltIn ? 'builtin' : 'http',
        ...(normalizedUrl ? { url: normalizedUrl } : {}),
      };
    })
    .filter((connection): connection is McpConnection => connection !== null);

  const hasDocsConnection = normalized.some((connection) => (
    connection.id === defaultDocsConnection.id || connection.name === defaultDocsConnection.name
  ));

  return hasDocsConnection ? dedupeMcpConnections(normalized) : [defaultDocsConnection, ...dedupeMcpConnections(normalized)];
}

export function normalizeMcpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'mcp';
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function dedupeMcpConnections(connections: readonly McpConnection[]): McpConnection[] {
  const seen = new Set<string>();
  return connections.filter((connection) => {
    const key = connection.url ? `url:${normalizeMcpUrl(connection.url)}` : `id:${connection.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
