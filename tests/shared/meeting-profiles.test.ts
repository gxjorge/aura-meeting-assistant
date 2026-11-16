import { describe, expect, it } from 'vitest';
import {
  createBlankProfile,
  createDefaultProfile,
  createProfileFromTemplate,
  DEFAULT_EXPLICIT_ANSWER_PROMPT,
  deleteProfile,
  exportProfile,
  getActiveProfile,
  importProfile,
  migrateLegacySettings,
  needsProfileMigration,
  normalizeProfileMcpServers,
  createWorkIqMcpServer,
  WORKIQ_MCP_URL,
  WORKIQ_READ_ONLY_TOOLS,
  normalizeProfiles,
  upsertProfile,
} from '../../src/shared/meeting-profiles.js';
import {
  DEFAULT_ANSWER_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_TRIAGE_MODEL,
  type AuraSettings,
  type LegacyAuraSettings,
  type MeetingProfile,
} from '../../src/shared/types.js';

const NOW = 1_700_000_000_000;

describe('profile defaults', () => {
  it('ships a non-deletable built-in Azure docs profile wired to the Microsoft Learn MCP', () => {
    const azureDocs = createDefaultProfile(NOW);

    expect(azureDocs.id).toBe('azure-docs');
    expect(azureDocs.builtIn).toBe(true);
    expect(azureDocs.passiveCardsEnabled).toBe(true);
    expect(azureDocs.explicitAnswersEnabled).toBe(true);
    expect(azureDocs.skills).toEqual([]);

    // Documentation is no longer a hardcoded card source: it is just an MCP server like any other.
    expect(azureDocs.mcpServers).toHaveLength(1);
    expect(azureDocs.mcpServers[0]).toMatchObject({
      id: 'microsoft-learn',
      transport: 'http',
      url: 'https://learn.microsoft.com/api/mcp',
      tools: ['*'],
      enabled: true,
    });
  });

  it('offers sales review, training, and document review starter templates', () => {
    const sales = createProfileFromTemplate('sales-review', [], NOW);
    const docReview = createProfileFromTemplate('document-review', [], NOW);
    const training = createProfileFromTemplate('training', [], NOW);

    expect(sales?.builtIn).toBe(false);
    expect(sales?.systemPrompt).toContain('Watch for:');
    expect(docReview?.builtIn).toBe(false);
    // Templates whose job is explaining concepts ship the docs MCP; sales-facing ones do not.
    expect(training?.mcpServers.map((server) => server.id)).toContain('microsoft-learn');
    expect(sales?.mcpServers).toEqual([]);
    expect(createProfileFromTemplate('not-a-template', [], NOW)).toBeNull();
  });

  it('gives templated profiles unique ids when one already exists', () => {
    const first = createProfileFromTemplate('training', [], NOW);
    if (!first) throw new Error('expected a training template');
    const second = createProfileFromTemplate('training', [first], NOW);

    expect(second?.id).not.toBe(first.id);
  });

  it('creates blank profiles that inherit the default explicit-answer prompt', () => {
    const blank = createBlankProfile('Customer QBR', [], NOW);

    expect(blank.id).toBe('customer-qbr');
    expect(blank.builtIn).toBe(false);
    expect(blank.systemPrompt.length).toBeGreaterThan(0);
  });

  it('separates the triage model from the answer model so classification stays cheap', () => {
    // Triage runs on every cadence tick and only emits a small JSON array, so it defaults to a fast
    // model. Measured on one transcript, the frontier answer model spent ~8.2s on the same call.
    const azureDocs = createDefaultProfile(NOW);
    const blank = createBlankProfile('Customer QBR', [], NOW);
    const training = createProfileFromTemplate('training', [], NOW);

    expect(azureDocs.triageModel).toBe(DEFAULT_TRIAGE_MODEL);
    expect(blank.triageModel).toBe(DEFAULT_TRIAGE_MODEL);
    expect(training?.triageModel).toBe(DEFAULT_TRIAGE_MODEL);
    expect(azureDocs.triageModel).not.toBe(azureDocs.answerModel);
  });
});

describe('normalizeProfiles', () => {
  it('always guarantees a default profile even when given nothing', () => {
    const { profiles, activeProfileId } = normalizeProfiles([], undefined, NOW);

    expect(profiles.map((profile) => profile.id)).toEqual(['azure-docs']);
    expect(profiles[0]?.builtIn).toBe(true);
    expect(activeProfileId).toBe('azure-docs');
  });

  it('forces the default profile to stay built-in', () => {
    const tampered = { ...createDefaultProfile(NOW), builtIn: false };

    expect(normalizeProfiles([tampered], 'azure-docs', NOW).profiles[0]?.builtIn).toBe(true);
  });

  it('drops malformed and duplicate profiles instead of throwing', () => {
    const junk = [{ name: 'no id' }, null, 42] as unknown as MeetingProfile[];
    const duplicated = [createDefaultProfile(NOW), createDefaultProfile(NOW)];

    expect(normalizeProfiles(junk, undefined, NOW).profiles.map((profile) => profile.id)).toEqual(['azure-docs']);
    expect(normalizeProfiles(duplicated, undefined, NOW).profiles).toHaveLength(1);
  });

  it('resolves a dangling activeProfileId back to the first profile', () => {
    const sales = createProfileFromTemplate('sales-review', [], NOW);
    if (!sales) throw new Error('expected a sales template');

    expect(normalizeProfiles([sales], 'deleted-profile', NOW).activeProfileId).toBe('azure-docs');
    expect(normalizeProfiles([sales], sales.id, NOW).activeProfileId).toBe(sales.id);
  });

  it('renames the old general profile to azure-docs and follows the active id across', () => {
    const legacyGeneral = { ...createDefaultProfile(NOW), id: 'general', name: 'General' };
    const { profiles, activeProfileId } = normalizeProfiles([legacyGeneral], 'general', NOW);

    expect(profiles.map((profile) => profile.id)).toEqual(['azure-docs']);
    expect(activeProfileId).toBe('azure-docs');
    // The user's own name survives the id rename.
    expect(profiles[0]?.name).toBe('General');
  });

  it('gives a persisted official-docs profile the Microsoft Learn MCP it used to get for free', () => {
    const legacyDocsProfile = {
      ...createDefaultProfile(NOW),
      id: 'legacy-docs',
      builtIn: false,
      mcpServers: [],
      passiveSource: 'official_docs',
    } as unknown as MeetingProfile;

    const migrated = findProfile(normalizeProfiles([legacyDocsProfile], 'legacy-docs', NOW), 'legacy-docs');

    expect(migrated?.mcpServers.map((server) => server.id)).toEqual(['microsoft-learn']);
    expect('passiveSource' in (migrated ?? {})).toBe(false);
  });

  it('backfills a triage model onto profiles saved before the field existed', () => {
    const preTriageModel = { ...createDefaultProfile(NOW), id: 'legacy', builtIn: false } as Partial<MeetingProfile>;
    delete preTriageModel.triageModel;
    const blanked = { ...createDefaultProfile(NOW), id: 'blanked', builtIn: false, triageModel: '   ' };

    const result = normalizeProfiles([preTriageModel as MeetingProfile, blanked], 'legacy', NOW);

    expect(findProfile(result, 'legacy')?.triageModel).toBe(DEFAULT_TRIAGE_MODEL);
    expect(findProfile(result, 'blanked')?.triageModel).toBe(DEFAULT_TRIAGE_MODEL);
  });

  it('does not duplicate the Learn MCP when the profile already has it', () => {
    const alreadyMigrated = {
      ...createDefaultProfile(NOW),
      id: 'legacy-docs',
      builtIn: false,
      passiveSource: 'official_docs',
    } as unknown as MeetingProfile;

    const migrated = findProfile(normalizeProfiles([alreadyMigrated], 'legacy-docs', NOW), 'legacy-docs');

    expect(migrated?.mcpServers.filter((server) => server.id === 'microsoft-learn')).toHaveLength(1);
  });

  it('leaves agent-source profiles without a docs server bolted on', () => {
    const legacyAgentProfile = {
      ...createDefaultProfile(NOW),
      id: 'legacy-agent',
      builtIn: false,
      mcpServers: [],
      passiveSource: 'agent',
    } as unknown as MeetingProfile;

    const migrated = findProfile(normalizeProfiles([legacyAgentProfile], 'legacy-agent', NOW), 'legacy-agent');

    expect(migrated?.mcpServers).toEqual([]);
  });

  it('refreshes a shipped prompt that still expects injected documentation URLs', () => {
    // This prompt is now the triage prompt too, so a stale one both mis-frames answers and leaves
    // triage classifying with criteria written for something else.
    const stale = {
      ...createDefaultProfile(NOW),
      id: 'stale',
      builtIn: false,
      systemPrompt: `You are Aura's explicit-answer agent.

Aura listens during meetings and starts exactly one answer agent when the user says they need to check, verify, or look something up.

Use only the official documentation URLs provided in the prompt as external grounding. If those docs do not answer the ask, say exactly what still needs verification instead of guessing or using unsupported sources.

Return a concise meeting-ready answer and cite the provided source URLs.`,
    };

    const migrated = findProfile(normalizeProfiles([stale], 'stale', NOW), 'stale');

    expect(migrated?.systemPrompt).toBe(DEFAULT_EXPLICIT_ANSWER_PROMPT);
    expect(migrated?.systemPrompt).toContain('Watch for:');
    expect(migrated?.systemPrompt).not.toContain('provided in the prompt');
  });

  it('never rewrites a prompt the user edited themselves', () => {
    const edited = {
      ...createDefaultProfile(NOW),
      id: 'edited',
      builtIn: false,
      systemPrompt: 'Surface every MSX opportunity mentioned by name.',
    };

    const once = findProfile(normalizeProfiles([edited], 'edited', NOW), 'edited');
    const twice = findProfile(normalizeProfiles([once as MeetingProfile], 'edited', NOW), 'edited');

    expect(once?.systemPrompt).toBe('Surface every MSX opportunity mentioned by name.');
    expect(twice?.systemPrompt).toBe('Surface every MSX opportunity mentioned by name.');
  });
});

/**
 * `normalizeProfiles` prepends the seeded default profile when it is missing, so positional lookup
 * would silently assert against the wrong profile.
 */
function findProfile(
  result: { profiles: MeetingProfile[] },
  id: string,
): MeetingProfile | undefined {
  return result.profiles.find((profile) => profile.id === id);
}

describe('normalizeProfileMcpServers', () => {
  it('defaults tools to every tool and drops servers missing their transport target', () => {
    const servers = normalizeProfileMcpServers([
      { id: 'msx', name: 'MSX', transport: 'http', url: 'https://mcp.example/msx/', tools: [], enabled: true },
      { id: 'no-url', name: 'Broken', transport: 'http', tools: ['*'], enabled: true },
      { id: 'no-command', name: 'Broken stdio', transport: 'stdio', tools: ['*'], enabled: true },
      { id: 'local', name: 'Local', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], tools: ['*'], enabled: true },
    ]);

    expect(servers.map((server) => server.id)).toEqual(['msx', 'local']);
    expect(servers[0]?.tools).toEqual(['*']);
    expect(servers[0]?.url).toBe('https://mcp.example/msx');
  });

  it('preserves the Work IQ auth marker and ships a read-only server preset', () => {
    const workIq = createWorkIqMcpServer();
    const [normalized] = normalizeProfileMcpServers([workIq]);

    expect(normalized?.url).toBe(WORKIQ_MCP_URL);
    expect(normalized?.authProvider).toBe('workiq');
    expect(normalized?.workIqAuth).toEqual({
      clientId: 'ba081686-5d24-4bc6-a0d6-d034ecffed87',
      tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    });
    expect(normalized?.tools).toEqual([...WORKIQ_READ_ONLY_TOOLS]);
    expect(normalized?.tools).not.toContain('create_entity');
    expect(normalized?.tools).not.toContain('update_entity');
    expect(normalized?.tools).not.toContain('delete_entity');
  });
});

describe('legacy settings migration', () => {
  const legacy: LegacyAuraSettings = {
    answerModel: 'gpt-5.4',
    // Deliberately the pre-profiles field names — this fixture models what is actually on disk.
    implicitDocsEnabled: false,
    explicitAnswersEnabled: true,
    docsCadence: { mode: 'interval', intervalSeconds: 9 },
    mcpConnections: [
      {
        id: 'microsoft-docs',
        name: 'Microsoft Docs',
        status: 'connected',
        transport: 'builtin',
      },
      {
        id: 'custom-team-docs-d008ce9f',
        name: 'Team Docs',
        status: 'configured',
        transport: 'http',
        url: 'https://mcp.contoso.example/docs',
      },
    ],
  };

  it('folds pre-profile meeting settings into the default profile', () => {
    const migrated = migrateLegacySettings(legacy, NOW);

    expect(migrated.id).toBe('azure-docs');
    expect(migrated.answerModel).toBe('gpt-5.4');
    // Legacy settings never had a triage model; the migrated profile gets the fast default, not the
    // user's (potentially slow) answer model.
    expect(migrated.triageModel).toBe(DEFAULT_TRIAGE_MODEL);
    expect(migrated.passiveCardsEnabled).toBe(false);
    expect('docsSensitivity' in migrated).toBe(false);
    expect(migrated.triageCadence).toEqual({ mode: 'interval', intervalSeconds: 9 });
  });

  describe('legacy answer model migration', () => {
    it('upgrades the previous shipped answer model default', () => {
      const profile = createDefaultProfile(NOW);
      const result = normalizeProfiles([
        { ...profile, answerModel: 'claude-sonnet-4.6' },
      ], profile.id, NOW);

      expect(findProfile(result, profile.id)?.answerModel).toBe(DEFAULT_ANSWER_MODEL);
    });

    it('preserves a deliberately configured answer model', () => {
      const profile = createDefaultProfile(NOW);
      const result = normalizeProfiles([
        { ...profile, answerModel: 'gpt-5.4' },
      ], profile.id, NOW);

      expect(findProfile(result, profile.id)?.answerModel).toBe('gpt-5.4');
    });
  });

  it('carries real MCP servers across and drops the built-in docs pseudo-connection', () => {
    const migrated = migrateLegacySettings(legacy, NOW);

    // The old `builtin` Microsoft Docs pseudo-connection becomes the real Learn MCP server.
    expect(migrated.mcpServers.map((server) => server.id)).toEqual(['microsoft-learn', 'custom-team-docs-d008ce9f']);
    expect(migrated.mcpServers[1]).toMatchObject({
      name: 'Team Docs',
      transport: 'http',
      url: 'https://mcp.contoso.example/docs',
      tools: ['*'],
      enabled: true,
    });
  });

  it('is idempotent', () => {
    expect(migrateLegacySettings(legacy, NOW)).toEqual(migrateLegacySettings(legacy, NOW));
  });

  it('tolerates a completely missing legacy blob', () => {
    expect(migrateLegacySettings(undefined, NOW)).toEqual(createDefaultProfile(NOW));
  });

  it('flags settings that still need migrating', () => {
    expect(needsProfileMigration(undefined)).toBe(true);
    expect(needsProfileMigration({ profiles: [] })).toBe(true);
    expect(needsProfileMigration({ profiles: [createDefaultProfile(NOW)] })).toBe(false);
  });

  it('ships DEFAULT_SETTINGS without any profile-owned meeting fields', () => {
    expect('answerModel' in DEFAULT_SETTINGS).toBe(false);
    expect('docsSensitivity' in DEFAULT_SETTINGS).toBe(false);
    expect('mcpConnections' in DEFAULT_SETTINGS).toBe(false);
    expect(DEFAULT_SETTINGS.activeProfileId).toBe('azure-docs');
  });
});

describe('profile CRUD', () => {
  const azureDocs = createDefaultProfile(NOW);
  const sales = createProfileFromTemplate('sales-review', [azureDocs], NOW);

  it('resolves the active profile and falls back safely', () => {
    if (!sales) throw new Error('expected a sales template');
    const settings: AuraSettings = { ...DEFAULT_SETTINGS, profiles: [azureDocs, sales], activeProfileId: sales.id };

    expect(getActiveProfile(settings).id).toBe(sales.id);
    expect(getActiveProfile({ ...settings, activeProfileId: 'gone' }).id).toBe('azure-docs');
    expect(getActiveProfile({ ...settings, profiles: [] }).id).toBe('azure-docs');
  });

  it('upserts by id and stamps updatedAt', () => {
    const renamed = { ...azureDocs, name: 'Default' };
    const updated = upsertProfile([azureDocs], renamed, NOW + 500);

    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Default');
    expect(updated[0]?.updatedAt).toBe(NOW + 500);
  });

  it('refuses to delete the built-in default profile', () => {
    if (!sales) throw new Error('expected a sales template');
    expect(deleteProfile([azureDocs, sales], 'azure-docs').map((profile) => profile.id)).toEqual([
      'azure-docs',
      sales.id,
    ]);
    expect(deleteProfile([azureDocs, sales], sales.id).map((profile) => profile.id)).toEqual(['azure-docs']);
  });
});

describe('export and import', () => {
  const withSecrets: MeetingProfile = {
    ...createDefaultProfile(NOW),
    id: 'sales',
    name: 'Sales review',
    builtIn: true,
    mcpServers: [
      {
        id: 'msx',
        name: 'MSX',
        transport: 'http',
        url: 'https://mcp.example/msx',
        tools: ['*'],
        enabled: true,
        headers: { Authorization: 'Bearer super-secret' },
      },
      {
        id: 'workiq',
        name: 'WorkIQ',
        transport: 'http',
        url: WORKIQ_MCP_URL,
        tools: ['*'],
        enabled: true,
        authProvider: 'workiq',
        workIqAuth: {
          clientId: 'ba081686-5d24-4bc6-a0d6-d034ecffed87',
          tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        },
        headers: { Authorization: 'Bearer super-secret' },
      },
    ],
  };

  it('strips credentials and built-in status from exported JSON', () => {
    const raw = exportProfile(withSecrets);

    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('Authorization');
    expect(raw).not.toContain('WORKIQ_TOKEN');

    const parsed = JSON.parse(raw) as { schemaVersion: number; profile: MeetingProfile };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.profile.builtIn).toBe(false);
    expect(parsed.profile.mcpServers.map((server) => server.id)).toEqual(['msx', 'workiq']);
    expect(parsed.profile.mcpServers[1]?.authProvider).toBe('workiq');
  });

  it('round-trips through import while re-slugging colliding ids', () => {
    const existing = [createDefaultProfile(NOW), withSecrets];
    const result = importProfile(exportProfile(withSecrets), existing, NOW + 1);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.profile.id).not.toBe('sales');
    expect(result.profile.name).toBe('Sales review');
    expect(result.profile.builtIn).toBe(false);
    expect(result.profile.mcpServers[0]?.headers ?? {}).toEqual({});
  });

  it('accepts a bare profile object as well as the wrapped envelope', () => {
    const bare = JSON.stringify({ ...withSecrets, id: 'bare-profile' });

    expect(importProfile(bare, [], NOW).ok).toBe(true);
  });

  it('reports parse and shape failures instead of throwing', () => {
    expect(importProfile('{ not json', [], NOW)).toEqual({
      ok: false,
      error: 'Profile JSON could not be parsed.',
    });
    expect(importProfile('42', [], NOW).ok).toBe(false);
    expect(importProfile(JSON.stringify({ profile: { name: '' } }), [], NOW).ok).toBe(false);
  });
});
