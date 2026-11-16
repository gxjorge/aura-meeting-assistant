import { describe, expect, it, vi } from 'vitest';
import { createDefaultProfile, createWorkIqMcpServer } from '../../src/shared/meeting-profiles.js';
import {
  createWorkIqAuthManager,
  createConfiguredWorkIqCredential,
  hydrateWorkIqMcpServers,
  WORKIQ_SCOPE,
} from '../../src/main/workiq-auth.js';

describe('Work IQ authentication', () => {
  const settings = {
    clientId: 'ba081686-5d24-4bc6-a0d6-d034ecffed87',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
  };

  it('builds the browser credential with Aura Work IQ settings', () => {
    const createCredential = vi.fn(() => ({
      authenticate: async () => undefined,
      getToken: async () => null,
    }));

    createConfiguredWorkIqCredential({
      clientId: 'ba081686-5d24-4bc6-a0d6-d034ecffed87',
      tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    }, createCredential);

    expect(createCredential).toHaveBeenCalledWith({
      clientId: 'ba081686-5d24-4bc6-a0d6-d034ecffed87',
      tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
      redirectUri: 'http://localhost',
      disableAutomaticAuthentication: true,
    });
  });

  it('connects interactively, caches only the credential instance, and disconnects', async () => {
    const credential = {
      authenticate: vi.fn(async () => ({ username: 'user@contoso.com' })),
      getToken: vi.fn(async () => ({ token: 'workiq-token' })),
    };
    const manager = createWorkIqAuthManager({
      createCredential: () => credential,
    });

    expect(manager.getStatus(settings).state).toBe('disconnected');
    expect(await manager.connect(settings)).toEqual({
      state: 'connected',
      username: 'user@contoso.com',
      configuredClient: true,
    });
    expect(credential.authenticate).toHaveBeenCalledWith(WORKIQ_SCOPE);
    expect(await manager.getAccessToken(settings)).toBe('workiq-token');
    expect(manager.disconnect().state).toBe('disconnected');
    await expect(manager.getAccessToken(settings)).rejects.toThrow('Work IQ is not connected');
  });

  it('returns an actionable admin-consent error', async () => {
    const manager = createWorkIqAuthManager({
      createCredential: () => ({
        authenticate: async () => {
          throw new Error('AADSTS65001: consent required');
        },
        getToken: async () => null,
      }),
    });

    await expect(manager.connect(settings)).resolves.toEqual({
      state: 'error',
      configuredClient: true,
      error: 'Tenant admin consent is required for the delegated WorkIQAgent.Ask permission.',
    });
  });

  it('explains a first-party preauthorization failure', async () => {
    const manager = createWorkIqAuthManager({
      createCredential: () => ({
        authenticate: async () => {
          throw new Error('AADSTS65002: Consent between first party applications must be configured via preauthorization');
        },
        getToken: async () => null,
      }),
    });

    expect((await manager.connect(settings)).error).toContain('configured OAuth client is not authorized');
  });

  it('does not reuse a token for a different Work IQ server configuration', async () => {
    const manager = createWorkIqAuthManager({
      createCredential: () => ({
        authenticate: async () => ({ username: 'user@contoso.com' }),
        getToken: async () => ({ token: 'workiq-token' }),
      }),
    });
    await manager.connect(settings);

    await expect(manager.getAccessToken({
      ...settings,
      clientId: '11111111-1111-1111-1111-111111111111',
    })).rejects.toThrow('Work IQ is not connected');
  });

  it('injects a bearer token only into marked Work IQ servers', async () => {
    const profile = {
      ...createDefaultProfile(),
      mcpServers: [
        createWorkIqMcpServer(),
        {
          id: 'docs',
          name: 'Docs',
          transport: 'http' as const,
          enabled: true,
          tools: ['*'],
          url: 'https://mcp.example/docs',
        },
      ],
    };
    const servers = {
      workiq: {
        type: 'http' as const,
        url: 'https://workiq.svc.cloud.microsoft/mcp',
        tools: ['ask'],
      },
      docs: {
        type: 'http' as const,
        url: 'https://mcp.example/docs',
        tools: ['*'],
      },
    };

    const hydrated = await hydrateWorkIqMcpServers(profile, servers, {
      getAccessToken: async (receivedSettings) => {
        expect(receivedSettings).toEqual(settings);
        return 'runtime-token';
      },
    });

    expect(hydrated.workiq).toEqual({
      ...servers.workiq,
      headers: { Authorization: 'Bearer runtime-token' },
    });
    expect(hydrated.docs).toEqual(servers.docs);
    expect(servers.workiq).not.toHaveProperty('headers');
  });
});
