import {
  DEFAULT_WORKIQ_CLIENT_ID,
  DEFAULT_WORKIQ_TENANT_ID,
} from './types.js';
import type { WorkIqAuthSettings } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateWorkIqAuthSettings(settings: WorkIqAuthSettings): string | null {
  if (!UUID_PATTERN.test(settings.clientId.trim())) {
    return 'Work IQ client ID must be a valid application ID.';
  }
  if (!UUID_PATTERN.test(settings.tenantId.trim())) {
    return 'Work IQ tenant ID must be a valid directory ID.';
  }
  return null;
}

export function normalizeWorkIqAuthSettings(
  settings: Partial<WorkIqAuthSettings> | undefined,
): WorkIqAuthSettings {
  const clientId = settings?.clientId?.trim();
  const tenantId = settings?.tenantId?.trim();
  return {
    clientId: clientId && UUID_PATTERN.test(clientId) ? clientId : DEFAULT_WORKIQ_CLIENT_ID,
    tenantId: tenantId && UUID_PATTERN.test(tenantId) ? tenantId : DEFAULT_WORKIQ_TENANT_ID,
  };
}
