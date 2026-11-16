import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { MeetingProfile } from '../shared/types.js';
import { buildSkillFileContent, enabledProfileSkills } from '../shared/profile-session-config.js';

/**
 * Copilot skills have to exist on disk because `SessionConfig.skillDirectories` takes paths. Aura
 * mirrors each profile's enabled skills into `<userData>/profile-skills/<profileId>/<skillId>/SKILL.md`
 * and hands the profile directory to the SDK.
 */
export function getProfileSkillsRoot(): string {
  return path.join(app.getPath('userData'), 'profile-skills');
}

export function getProfileSkillsDirectory(profileId: string): string {
  return path.join(getProfileSkillsRoot(), profileId);
}

/**
 * Writes the profile's enabled skills to disk and removes any stale skill folders left behind by
 * earlier edits. Returns the directory to pass as `skillDirectories`, or `undefined` when the
 * profile has no usable skills.
 */
export function stageProfileSkills(profile: MeetingProfile): string | undefined {
  const skills = enabledProfileSkills(profile);
  const profileDir = getProfileSkillsDirectory(profile.id);

  try {
    if (skills.length === 0) {
      removeDirectory(profileDir);
      return undefined;
    }

    fs.mkdirSync(profileDir, { recursive: true });

    const expected = new Set(skills.map((skill) => skill.id));
    for (const entry of readDirectoryNames(profileDir)) {
      if (!expected.has(entry)) removeDirectory(path.join(profileDir, entry));
    }

    for (const skill of skills) {
      const skillDir = path.join(profileDir, skill.id);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const content = buildSkillFileContent(skill);

      if (readFileOrNull(skillFile) === content) continue;
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillFile, content, 'utf-8');
    }

    return profileDir;
  } catch (err) {
    console.error('[ProfileSkills] Failed to stage skills for', profile.id, err);
    return undefined;
  }
}

/** Drops staged skills for profiles that no longer exist. */
export function pruneProfileSkills(profiles: readonly MeetingProfile[]): void {
  const root = getProfileSkillsRoot();
  const known = new Set(profiles.map((profile) => profile.id));

  for (const entry of readDirectoryNames(root)) {
    if (!known.has(entry)) removeDirectory(path.join(root, entry));
  }
}

function readDirectoryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function removeDirectory(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[ProfileSkills] Failed to remove', dir, err);
  }
}
