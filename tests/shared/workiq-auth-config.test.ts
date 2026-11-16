import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKIQ_CLIENT_ID,
  DEFAULT_WORKIQ_TENANT_ID,
} from '../../src/shared/types.js';
import {
  normalizeWorkIqAuthSettings,
  validateWorkIqAuthSettings,
} from '../../src/shared/workiq-auth-config.js';

describe('Work IQ auth configuration', () => {
  it('uses Aura registration defaults for older settings', () => {
    expect(normalizeWorkIqAuthSettings(undefined)).toEqual({
      clientId: DEFAULT_WORKIQ_CLIENT_ID,
      tenantId: DEFAULT_WORKIQ_TENANT_ID,
    });
  });

  it('preserves valid custom client and tenant IDs', () => {
    const custom = {
      clientId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
    };
    expect(normalizeWorkIqAuthSettings(custom)).toEqual(custom);
    expect(validateWorkIqAuthSettings(custom)).toBeNull();
  });

  it('rejects malformed identifiers', () => {
    expect(validateWorkIqAuthSettings({
      clientId: 'not-an-app-id',
      tenantId: DEFAULT_WORKIQ_TENANT_ID,
    })).toBe('Work IQ client ID must be a valid application ID.');
  });

  it('replaces malformed imported identifiers with defaults', () => {
    expect(normalizeWorkIqAuthSettings({
      clientId: 'invalid',
      tenantId: '',
    })).toEqual({
      clientId: DEFAULT_WORKIQ_CLIENT_ID,
      tenantId: DEFAULT_WORKIQ_TENANT_ID,
    });
  });
});
