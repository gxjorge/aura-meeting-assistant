import { InteractiveBrowserCredential } from '@azure/identity';
import type {
  AgentMcpServerConfig,
  MeetingProfile,
  WorkIqAuthSettings,
  WorkIqAuthStatus,
} from '../shared/types.js';
import { validateWorkIqAuthSettings } from '../shared/workiq-auth-config.js';

export const WORKIQ_SCOPE = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask';

interface WorkIqAccessToken {
  token: string;
}

interface WorkIqAuthenticationRecord {
  username?: string;
}

export interface WorkIqCredential {
  authenticate: (scopes: string | string[]) => Promise<WorkIqAuthenticationRecord | undefined>;
  getToken: (scopes: string | string[]) => Promise<WorkIqAccessToken | null>;
}

interface WorkIqAuthManagerDependencies {
  createCredential: (settings: WorkIqAuthSettings) => WorkIqCredential;
}

export interface WorkIqAuthManager {
  getStatus: (settings: WorkIqAuthSettings) => WorkIqAuthStatus;
  connect: (settings: WorkIqAuthSettings) => Promise<WorkIqAuthStatus>;
  disconnect: () => WorkIqAuthStatus;
  getAccessToken: (settings: WorkIqAuthSettings) => Promise<string>;
}

export interface WorkIqBrowserCredentialOptions {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  disableAutomaticAuthentication: boolean;
}

export function createConfiguredWorkIqCredential(
  settings: WorkIqAuthSettings,
  createCredential: (options: WorkIqBrowserCredentialOptions) => WorkIqCredential = (
    options,
  ) => new InteractiveBrowserCredential(options),
): WorkIqCredential {
  return createCredential({
    tenantId: settings.tenantId,
    clientId: settings.clientId,
    redirectUri: 'http://localhost',
    disableAutomaticAuthentication: true,
  });
}

export function createWorkIqAuthManager(
  dependencies: WorkIqAuthManagerDependencies,
): WorkIqAuthManager {
  let credential: WorkIqCredential | null = null;
  let configurationKey: string | null = null;
  let status: WorkIqAuthStatus = {
    state: 'disconnected',
    configuredClient: true,
  };

  const getCredential = (settings: WorkIqAuthSettings): WorkIqCredential => {
    const nextKey = workIqConfigurationKey(settings);
    if (configurationKey !== nextKey) {
      credential = null;
      configurationKey = nextKey;
    }
    credential ??= dependencies.createCredential(settings);
    return credential;
  };

  return {
    getStatus: (settings) => (
      configurationKey === workIqConfigurationKey(settings)
        ? { ...status }
        : { state: 'disconnected', configuredClient: true }
    ),

    connect: async (settings) => {
      const validationError = validateWorkIqAuthSettings(settings);
      if (validationError) {
        return { state: 'error', configuredClient: true, error: validationError };
      }
      status = {
        state: 'connecting',
        configuredClient: true,
      };

      try {
        const currentCredential = getCredential(settings);
        const record = await currentCredential.authenticate(WORKIQ_SCOPE);
        const token = await currentCredential.getToken(WORKIQ_SCOPE);
        if (!token?.token) {
          throw new Error('Microsoft Entra did not return a Work IQ access token.');
        }

        status = {
          state: 'connected',
          configuredClient: true,
          ...(record?.username ? { username: record.username } : {}),
        };
      } catch (err) {
        credential = null;
        status = {
          state: 'error',
          configuredClient: true,
          error: formatWorkIqAuthError(err),
        };
      }

      return { ...status };
    },

    disconnect: () => {
      credential = null;
      status = {
        state: 'disconnected',
        configuredClient: true,
      };
      configurationKey = null;
      return { ...status };
    },

    getAccessToken: async (settings) => {
      if (
        status.state !== 'connected'
        || !credential
        || configurationKey !== workIqConfigurationKey(settings)
      ) {
        throw new Error('Work IQ is not connected. Open Meeting profiles and select Connect.');
      }

      try {
        const token = await credential.getToken(WORKIQ_SCOPE);
        if (!token?.token) {
          throw new Error('Microsoft Entra did not return a Work IQ access token.');
        }
        return token.token;
      } catch (err) {
        const message = formatWorkIqAuthError(err);
        credential = null;
        status = {
          state: 'error',
          configuredClient: true,
          error: message,
        };
        throw new Error(`Work IQ authentication failed: ${message}`);
      }
    },
  };
}

const defaultManager = createWorkIqAuthManager({
  createCredential: createConfiguredWorkIqCredential,
});

export function getWorkIqAuthStatus(settings: WorkIqAuthSettings): WorkIqAuthStatus {
  return defaultManager.getStatus(settings);
}

export async function connectWorkIq(settings: WorkIqAuthSettings): Promise<WorkIqAuthStatus> {
  return await defaultManager.connect(settings);
}

export function disconnectWorkIq(): WorkIqAuthStatus {
  return defaultManager.disconnect();
}

export async function hydrateWorkIqMcpServers(
  profile: MeetingProfile,
  servers: Record<string, AgentMcpServerConfig>,
  manager: Pick<WorkIqAuthManager, 'getAccessToken'> = defaultManager,
): Promise<Record<string, AgentMcpServerConfig>> {
  const workIqServers = profile.mcpServers
    .filter((server) => server.enabled && server.authProvider === 'workiq');

  if (workIqServers.length === 0) return servers;

  const authSettings = workIqServers[0]?.workIqAuth;
  if (!authSettings) {
    throw new Error('Work IQ MCP server is missing its client or tenant ID.');
  }
  const expectedKey = workIqConfigurationKey(authSettings);
  if (workIqServers.some((server) => (
    !server.workIqAuth || workIqConfigurationKey(server.workIqAuth) !== expectedKey
  ))) {
    throw new Error('A profile cannot use Work IQ servers with different OAuth applications.');
  }

  const token = await manager.getAccessToken(authSettings);
  const hydrated = { ...servers };

  for (const { id: serverId } of workIqServers) {
    const server = hydrated[serverId];
    if (!server || !('url' in server)) continue;
    hydrated[serverId] = {
      ...server,
      headers: {
        ...(server.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    };
  }

  return hydrated;
}

function workIqConfigurationKey(settings: WorkIqAuthSettings): string {
  return `${settings.tenantId.trim().toLowerCase()}:${settings.clientId.trim().toLowerCase()}`;
}

function formatWorkIqAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/AADSTS65002|first.party.*preauthoriz/i.test(message)) {
    return 'The configured OAuth client is not authorized for Work IQ. Check the Work IQ client ID and tenant admin consent.';
  }
  if (/consent|AADSTS65001|AADSTS90094/i.test(message)) {
    return 'Tenant admin consent is required for the delegated WorkIQAgent.Ask permission.';
  }
  if (/cancel|user_cancelled/i.test(message)) {
    return 'Microsoft sign-in was cancelled.';
  }
  return message || 'Microsoft sign-in failed.';
}
