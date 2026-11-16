import type {
  AgentMcpServerConfig,
  AgentSessionConfig,
  MeetingProfile,
  ProfileMcpServer,
  ProfileSkill,
} from './types.js';

export interface AgentSessionConfigOptions {
  /**
   * Absolute path to the directory that holds this profile's staged skill folders. Omit when no
   * skills have been staged yet; the SDK expects parent directories, not individual skill folders.
   */
  skillsDirectory?: string;
  /** Overrides `profile.systemPrompt`, e.g. when building a passive-card session. */
  systemPrompt?: string;
  /** Overrides `profile.answerModel`. */
  model?: string;
}

/**
 * Maps a profile onto everything a single Copilot SDK session needs. Pure: no filesystem access and
 * no SDK import, so it can be unit-tested without Electron.
 */
export function buildAgentSessionConfig(
  profile: MeetingProfile,
  options: AgentSessionConfigOptions = {},
): AgentSessionConfig {
  const hasSkills = enabledProfileSkills(profile).length > 0;

  return {
    model: options.model?.trim() || profile.answerModel,
    systemPrompt: options.systemPrompt?.trim() || profile.systemPrompt,
    mcpServers: buildProfileMcpServers(profile),
    skillDirectories: hasSkills && options.skillsDirectory ? [options.skillsDirectory] : [],
  };
}

export function buildProfileMcpServers(
  profile: MeetingProfile,
): Record<string, AgentMcpServerConfig> {
  const servers: Record<string, AgentMcpServerConfig> = {};

  for (const server of profile.mcpServers) {
    if (!server.enabled) continue;
    const config = toAgentMcpServerConfig(server);
    if (config) servers[server.id] = config;
  }

  return servers;
}

function toAgentMcpServerConfig(server: ProfileMcpServer): AgentMcpServerConfig | null {
  // `tools` is required by the SDK; `['*']` means "every tool on this server".
  const tools = server.tools.length > 0 ? [...server.tools] : ['*'];
  const timeout = typeof server.timeout === 'number' ? { timeout: server.timeout } : {};

  if (server.transport === 'stdio') {
    const command = server.command?.trim();
    if (!command) return null;
    return {
      tools,
      ...timeout,
      type: 'local',
      command,
      args: [...(server.args ?? [])],
      ...(hasEntries(server.env) ? { env: { ...server.env } } : {}),
      ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}),
    };
  }

  const url = server.url?.trim();
  if (!url) return null;
  return {
    tools,
    ...timeout,
    type: server.transport,
    url,
    ...(server.authProvider !== 'workiq' && hasEntries(server.headers)
      ? { headers: { ...server.headers } }
      : {}),
  };
}

export function enabledProfileSkills(profile: MeetingProfile): ProfileSkill[] {
  return profile.skills.filter((skill) => skill.enabled && skill.body.trim().length > 0);
}

/** Renders a `SKILL.md` file: generated YAML frontmatter followed by the user's markdown body. */
export function buildSkillFileContent(skill: ProfileSkill): string {
  const description = skill.description.trim() || skill.name.trim();
  const frontmatter = [
    '---',
    `name: ${yamlScalar(skill.id)}`,
    `description: ${yamlScalar(description)}`,
    '---',
  ].join('\n');

  return `${frontmatter}\n\n${skill.body.trim()}\n`;
}

function yamlScalar(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return `"${collapsed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function hasEntries(record: Record<string, string> | undefined): record is Record<string, string> {
  return Boolean(record) && Object.keys(record as Record<string, string>).length > 0;
}
