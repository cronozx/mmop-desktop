import {
  parseModId,
  formatModId,
  getModProvider,
} from '../main/services/modProvider.js';
import {
  normalizeModrinthSearchHit,
  normalizeModrinthProject,
  normalizeModrinthVersion,
} from '../main/services/modrinth.js';
import { getModpackProviders, getModProviders } from '../config/games.js';

// Pure-function tests only — no network calls.

describe('getModProviders', () => {
  it('offers both Modrinth and CurseForge for Minecraft (Modrinth first)', () => {
    expect(getModProviders(1)).toEqual([
      { id: 'modrinth', label: 'Modrinth' },
      { id: 'curseforge', label: 'CurseForge' },
    ]);
  });

  it('returns a single source for single-provider games', () => {
    expect(getModProviders(34)).toEqual([{ id: 'thunderstore', label: 'Thunderstore' }]); // Lethal Company
  });

  it('returns nothing for unknown games', () => {
    expect(getModProviders(999)).toEqual([]);
    expect(getModProviders(undefined)).toEqual([]);
  });
});

describe('getModpackProviders', () => {
  it('offers both Modrinth and CurseForge for Minecraft (Modrinth first)', () => {
    expect(getModpackProviders(1)).toEqual([
      { id: 'modrinth', label: 'Modrinth' },
      { id: 'curseforge', label: 'CurseForge' },
    ]);
  });

  it('returns nothing for games without browsable modpacks', () => {
    expect(getModpackProviders(34)).toEqual([]); // Lethal Company (Thunderstore)
    expect(getModpackProviders(999)).toEqual([]);
    expect(getModpackProviders(undefined)).toEqual([]);
  });
});

describe('parseModId', () => {
  it('parses mr:-prefixed Modrinth ids', () => {
    expect(parseModId('mr:AANobbMI')).toEqual({ provider: 'modrinth', id: 'AANobbMI' });
    expect(parseModId('mr:P7dR8mSH')).toEqual({ provider: 'modrinth', id: 'P7dR8mSH' });
  });

  it('parses ts:-prefixed Thunderstore ids', () => {
    expect(parseModId('ts:BepInEx-BepInExPack')).toEqual({ provider: 'thunderstore', id: 'BepInEx-BepInExPack' });
  });

  it('parses cf:-prefixed CurseForge ids', () => {
    expect(parseModId('cf:238222')).toEqual({ provider: 'curseforge', id: '238222' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseModId(' mr:AANobbMI ')).toEqual({ provider: 'modrinth', id: 'AANobbMI' });
  });

  it('rejects invalid ids', () => {
    expect(parseModId('')).toBeNull();
    expect(parseModId('mr:')).toBeNull();
    expect(parseModId('xx:123')).toBeNull();
    // Bare (unprefixed) ids are no longer recognized for any provider.
    expect(parseModId('238222')).toBeNull();
    expect(parseModId('AANobbMI')).toBeNull();
    // Modrinth ids may not contain spaces or other punctuation.
    expect(parseModId('mr:has space')).toBeNull();
    expect(parseModId('mr:a/b')).toBeNull();
    // CurseForge ids are numeric only.
    expect(parseModId('cf:abc')).toBeNull();
    // Over-long ids are rejected.
    expect(parseModId(`mr:${'a'.repeat(65)}`)).toBeNull();
    expect(parseModId(123)).toBeNull();
    expect(parseModId(null)).toBeNull();
    expect(parseModId(undefined)).toBeNull();
  });
});

describe('formatModId', () => {
  it('formats provider-prefixed ids', () => {
    expect(formatModId('modrinth', 'AANobbMI')).toBe('mr:AANobbMI');
    expect(formatModId('thunderstore', 'BepInEx-BepInExPack')).toBe('ts:BepInEx-BepInExPack');
    expect(formatModId('curseforge', 238222)).toBe('cf:238222');
  });

  it('round-trips through parseModId', () => {
    expect(parseModId(formatModId('modrinth', 'AANobbMI'))).toEqual({ provider: 'modrinth', id: 'AANobbMI' });
  });
});

describe('getModProvider', () => {
  it('returns the matching provider implementation', () => {
    expect(getModProvider('modrinth').id).toBe('modrinth');
    expect(getModProvider('thunderstore').id).toBe('thunderstore');
    expect(getModProvider('curseforge').id).toBe('curseforge');
  });
});

describe('normalizeModrinthSearchHit', () => {
  it('maps a search hit to the normalized summary with a prefixed _id', () => {
    expect(normalizeModrinthSearchHit({
      project_id: 'AANobbMI',
      title: 'Sodium',
      author: 'jellysquid3',
      description: 'A modern rendering engine',
      icon_url: 'https://cdn.modrinth.com/icon.png',
    })).toEqual({
      _id: 'mr:AANobbMI',
      name: 'Sodium',
      author: 'jellysquid3',
      summary: 'A modern rendering engine',
      logo: 'https://cdn.modrinth.com/icon.png',
      sourceUrl: 'https://modrinth.com/mod/AANobbMI',
    });
  });

  it('falls back for missing author and icon', () => {
    const normalized = normalizeModrinthSearchHit({ project_id: 'abc', title: 'Thing', icon_url: null });
    expect(normalized.author).toBe('Unknown');
    expect(normalized.logo).toBeUndefined();
  });
});

describe('normalizeModrinthProject', () => {
  it('maps a project with a resolved author', () => {
    expect(normalizeModrinthProject(
      { id: 'P7dR8mSH', title: 'Fabric API', description: 'Core API', icon_url: 'https://cdn.modrinth.com/fa.png', team: 'team1' },
      'modmuss50'
    )).toEqual({
      _id: 'mr:P7dR8mSH',
      name: 'Fabric API',
      author: 'modmuss50',
      summary: 'Core API',
      logo: 'https://cdn.modrinth.com/fa.png',
      sourceUrl: 'https://modrinth.com/mod/P7dR8mSH',
    });
  });

  it('defaults the author to Unknown', () => {
    expect(normalizeModrinthProject({ id: 'abc', title: 'Thing' }).author).toBe('Unknown');
  });
});

describe('normalizeModrinthVersion', () => {
  const baseVersion = {
    id: 'ver1',
    name: 'Sodium 0.5.3',
    date_published: '2023-11-01T00:00:00Z',
    game_versions: ['1.20.1'],
    files: [
      { url: 'https://cdn.modrinth.com/other.jar', filename: 'other.jar', primary: false },
      { url: 'https://cdn.modrinth.com/sodium.jar', filename: 'sodium-fabric-0.5.3.jar', primary: true },
    ],
    dependencies: [
      { project_id: 'P7dR8mSH', dependency_type: 'required' },
      { project_id: 'optdep', dependency_type: 'optional' },
      { project_id: null, dependency_type: 'required' },
    ],
  };

  it('uses the primary file and prefixes dependency ids', () => {
    expect(normalizeModrinthVersion(baseVersion)).toEqual({
      id: 'ver1',
      displayName: 'Sodium 0.5.3',
      fileName: 'sodium-fabric-0.5.3.jar',
      fileDate: '2023-11-01T00:00:00Z',
      downloadUrl: 'https://cdn.modrinth.com/sodium.jar',
      gameVersions: ['1.20.1'],
      dependencies: [
        { modId: 'mr:P7dR8mSH', required: true },
        { modId: 'mr:optdep', required: false },
      ],
    });
  });

  it('falls back to the first file when no file is marked primary', () => {
    const version = {
      ...baseVersion,
      files: [{ url: 'https://cdn.modrinth.com/a.jar', filename: 'a.jar' }],
      dependencies: [],
    };
    const normalized = normalizeModrinthVersion(version);
    expect(normalized.fileName).toBe('a.jar');
    expect(normalized.dependencies).toEqual([]);
  });

  it('returns null when the version has no usable file', () => {
    expect(normalizeModrinthVersion({ ...baseVersion, files: [] })).toBeNull();
    expect(normalizeModrinthVersion({ ...baseVersion, files: undefined })).toBeNull();
  });
});
