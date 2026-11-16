import { describe, expect, it } from 'vitest';
import {
  buildAgentSessionConfig,
  buildProfileMcpServers,
  buildSkillFileContent,
  enabledProfileSkills,
} from '../../src/shared/profile-session-config.js';
import { createDefaultProfile } from '../../src/shared/meeting-profiles.js';
import type { MeetingProfile, ProfileSkill } from '../../src/shared/types.js';

const NOW = 1_700_000_000_000;

function profileWith(overrides: Partial<MeetingProfile>): MeetingProfile {
  return { ...createDefaultProfile(NOW), ...overrides };
}

describe('buildProfileMcpServers', () => {
  it('discriminates stdio from http and sse transports', () => {
    const servers = buildProfileMcpServers(profileWith({
      mcpServers: [
        {
          id: 'workiq',
          name: 'WorkIQ',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'workiq-mcp'],
          env: { WORKIQ_TOKEN: 'token' },
          cwd: 'C:/tmp',
          tools: ['*'],
          enabled: true,
        },
        {
          id: 'msx',
          name: 'MSX',
          transport: 'http',
          url: 'https://mcp.example/msx',
          headers: { Authorization: 'Bearer t' },
          tools: ['search'],
          enabled: true,
        },
        {
          id: 'events',
          name: 'Events',
          transport: 'sse',
          url: 'https://mcp.example/sse',
          tools: [],
          enabled: true,
        },
        {
          id: 'workiq-http',
          name: 'Work IQ',
          transport: 'http',
          url: 'https://workiq.svc.cloud.microsoft/mcp',
          headers: { Authorization: 'Bearer persisted-token' },
          authProvider: 'workiq',
          tools: ['ask'],
          enabled: true,
        },
      ],
    }));

    expect(servers.workiq).toEqual({
      tools: ['*'],
      type: 'local',
      command: 'npx',
      args: ['-y', 'workiq-mcp'],
      env: { WORKIQ_TOKEN: 'token' },
      cwd: 'C:/tmp',
    });
    expect(servers.msx).toEqual({
      tools: ['search'],
      type: 'http',
      url: 'https://mcp.example/msx',
      headers: { Authorization: 'Bearer t' },
    });
    expect(servers.events).toEqual({ tools: ['*'], type: 'sse', url: 'https://mcp.example/sse' });
    expect(servers['workiq-http']).toEqual({
      tools: ['ask'],
      type: 'http',
      url: 'https://workiq.svc.cloud.microsoft/mcp',
    });
  });

  it('omits disabled servers and servers missing their transport target', () => {
    const servers = buildProfileMcpServers(profileWith({
      mcpServers: [
        { id: 'off', name: 'Off', transport: 'http', url: 'https://mcp.example/off', tools: ['*'], enabled: false },
        { id: 'no-url', name: 'No URL', transport: 'http', url: '  ', tools: ['*'], enabled: true },
        { id: 'no-command', name: 'No command', transport: 'stdio', command: '   ', tools: ['*'], enabled: true },
      ],
    }));

    expect(servers).toEqual({});
  });

  it('always emits a tools array because the SDK requires it', () => {
    const servers = buildProfileMcpServers(profileWith({
      mcpServers: [
        { id: 'msx', name: 'MSX', transport: 'http', url: 'https://mcp.example/msx', tools: [], enabled: true },
      ],
    }));

    expect(servers.msx?.tools).toEqual(['*']);
  });
});

describe('buildAgentSessionConfig', () => {
  it('maps the profile prompt and model, carrying the profile MCP servers through', () => {
    const profile = profileWith({ answerModel: 'claude-sonnet-5.5', systemPrompt: 'Answer carefully.' });

    expect(buildAgentSessionConfig(profile)).toEqual({
      model: 'claude-sonnet-5.5',
      systemPrompt: 'Answer carefully.',
      // The seeded profile reaches documentation through the Microsoft Learn MCP, not a built-in path.
      mcpServers: {
        'microsoft-learn': { type: 'http', url: 'https://learn.microsoft.com/api/mcp', tools: ['*'] },
      },
      skillDirectories: [],
    });
  });

  it('emits no MCP servers for a profile that has none', () => {
    const profile = profileWith({ mcpServers: [] });

    expect(buildAgentSessionConfig(profile).mcpServers).toEqual({});
  });

  it('lets a passive-card session override the prompt and model', () => {
    const profile = profileWith({ answerModel: 'claude-sonnet-5.5', systemPrompt: 'Explicit.' });

    const config = buildAgentSessionConfig(profile, {
      systemPrompt: 'Passive context prompt.',
      model: 'gpt-5.4',
    });

    expect(config.systemPrompt).toBe('Passive context prompt.');
    expect(config.model).toBe('gpt-5.4');
  });

  it('ignores blank overrides', () => {
    const profile = profileWith({ answerModel: 'claude-sonnet-5.5', systemPrompt: 'Explicit.' });

    const config = buildAgentSessionConfig(profile, { systemPrompt: '   ', model: '  ' });

    expect(config.systemPrompt).toBe('Explicit.');
    expect(config.model).toBe('claude-sonnet-5.5');
  });

  it('only passes a skill directory when the profile actually has staged skills', () => {
    const skill: ProfileSkill = {
      id: 'pipeline-review',
      name: 'Pipeline review',
      description: 'How to review a sales pipeline.',
      body: 'Summarise stage, amount, and next step.',
      enabled: true,
    };
    const skillsDirectory = 'C:/Users/x/AppData/Roaming/Aura/profile-skills/sales';

    expect(buildAgentSessionConfig(profileWith({ skills: [skill] }), { skillsDirectory }).skillDirectories)
      .toEqual([skillsDirectory]);
    expect(buildAgentSessionConfig(profileWith({ skills: [skill] })).skillDirectories).toEqual([]);
    expect(buildAgentSessionConfig(profileWith({ skills: [] }), { skillsDirectory }).skillDirectories).toEqual([]);
  });
});

describe('enabledProfileSkills', () => {
  it('skips disabled and empty-bodied skills', () => {
    const skills: ProfileSkill[] = [
      { id: 'a', name: 'A', description: 'a', body: 'body', enabled: true },
      { id: 'b', name: 'B', description: 'b', body: 'body', enabled: false },
      { id: 'c', name: 'C', description: 'c', body: '   ', enabled: true },
    ];

    expect(enabledProfileSkills(profileWith({ skills })).map((skill) => skill.id)).toEqual(['a']);
  });
});

describe('buildSkillFileContent', () => {
  it('renders SKILL.md frontmatter followed by the body', () => {
    const content = buildSkillFileContent({
      id: 'pipeline-review',
      name: 'Pipeline review',
      description: 'How to review a sales pipeline.',
      body: '## Steps\n\n1. Check stage.\n',
      enabled: true,
    });

    expect(content).toBe(
      [
        '---',
        'name: "pipeline-review"',
        'description: "How to review a sales pipeline."',
        '---',
        '',
        '## Steps',
        '',
        '1. Check stage.',
        '',
      ].join('\n'),
    );
  });

  it('falls back to the skill name and escapes quotes in frontmatter', () => {
    const content = buildSkillFileContent({
      id: 'quoted',
      name: 'Say "hi"',
      description: '   ',
      body: 'body',
      enabled: true,
    });

    expect(content).toContain('description: "Say \\"hi\\""');
  });

  it('collapses multi-line descriptions so the YAML stays a single scalar', () => {
    const content = buildSkillFileContent({
      id: 'multi',
      name: 'Multi',
      description: 'line one\nline two',
      body: 'body',
      enabled: true,
    });

    expect(content).toContain('description: "line one line two"');
  });
});
