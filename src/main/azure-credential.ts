import { DefaultAzureCredential } from '@azure/identity';

/** Scope for Microsoft Foundry and Azure Speech resources; the same token works for both. */
export const AZURE_COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

export interface TokenProvider {
  getToken: (scopes: string | string[]) => Promise<{
    token: string;
    expiresOnTimestamp?: number;
  } | null>;
}

/**
 * One credential for everything that talks to the user's Azure resource, so the token is cached once
 * and the (slow) credential-chain discovery happens once per process.
 */
export const defaultAzureCredential: TokenProvider = new DefaultAzureCredential();
