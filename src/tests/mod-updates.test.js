import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkModUpdatesForPack,
  compareResolvedWithInstalled,
  collectStaleModFileNames,
  listInstalledModFiles,
  removeStaleModFiles,
  pickBestFile,
} from '../main/services/modUpdates.js';
import { isSafeModFileName } from '../main/validation.js';

// Offline tests only — provider lookups are injected as stub resolvers and the
// instance mods dir is a temp directory with fake jar files (no network).

const PACK = { name: 'Test Pack', mods: [], minecraftVersion: '1.20.1', modLoader: 'fabric' };

const file = (fileName, fileDate = '2026-01-02T00:00:00Z') => ({
  id: '1',
  displayName: fileName,
  fileName,
  fileDate,
  downloadUrl: `https://example.invalid/${fileName}`,
  gameVersions: ['1.20.1', 'fabric'],
  dependencies: [],
});

const resolvedMod = (overrides = {}) => ({
  id: 'mr:abc',
  name: 'Sodium',
  bestFile: file('sodium-2.0.jar'),
  knownFileNames: ['sodium-2.0.jar', 'sodium-1.0.jar'],
  ...overrides,
});

const stubResolver = (resolved, failures = []) => async () => ({ resolved, failures });

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmop-mod-updates-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const makeModsDir = (fileNames = []) => {
  const modsDir = path.join(tmpDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  for (const fileName of fileNames) {
    fs.writeFileSync(path.join(modsDir, fileName), 'fake jar');
  }
  return modsDir;
};

describe('checkModUpdatesForPack', () => {
  it('detects an update when the newest file name differs from the installed one', async () => {
    const modsDir = makeModsDir(['sodium-1.0.jar']);

    const result = await checkModUpdatesForPack(PACK, modsDir, stubResolver([resolvedMod()]));

    expect(result.checked).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.updates).toEqual([
      {
        id: 'mr:abc',
        name: 'Sodium',
        installedFileName: 'sodium-1.0.jar',
        latestFileName: 'sodium-2.0.jar',
        latestFileDate: '2026-01-02T00:00:00Z',
      },
    ]);
  });

  it('reports no update when the installed file already is the newest one', async () => {
    const modsDir = makeModsDir(['sodium-2.0.jar']);

    const result = await checkModUpdatesForPack(PACK, modsDir, stubResolver([resolvedMod()]));

    expect(result.checked).toBe(1);
    expect(result.updates).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('reports not-installed mods with installedFileName null', async () => {
    const modsDir = makeModsDir(['some-unrelated-mod.jar']);

    const result = await checkModUpdatesForPack(PACK, modsDir, stubResolver([resolvedMod()]));

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].installedFileName).toBeNull();
    expect(result.updates[0].latestFileName).toBe('sodium-2.0.jar');
  });

  it('works when the mods dir does not exist (everything not installed)', async () => {
    const modsDir = path.join(tmpDir, 'does-not-exist');

    const result = await checkModUpdatesForPack(PACK, modsDir, stubResolver([resolvedMod()]));

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].installedFileName).toBeNull();
  });

  it('buckets resolver failures and no-compatible-file mods into failures', async () => {
    const modsDir = makeModsDir(['sodium-1.0.jar']);
    const resolver = stubResolver(
      [resolvedMod(), resolvedMod({ id: 'mr:oldmod', name: 'Old Mod', bestFile: null, knownFileNames: [] })],
      [{ id: 'bogus!!', reason: 'Unrecognized mod id' }]
    );

    const result = await checkModUpdatesForPack(PACK, modsDir, resolver);

    expect(result.checked).toBe(3);
    expect(result.updates).toHaveLength(1);
    expect(result.failures).toEqual([
      { id: 'bogus!!', reason: 'Unrecognized mod id' },
      { id: 'mr:oldmod', reason: 'No compatible file found for Minecraft 1.20.1 (fabric)' },
    ]);
  });
});

describe('compareResolvedWithInstalled', () => {
  it('only matches files belonging to the mod (other jars are ignored)', () => {
    const { updates } = compareResolvedWithInstalled(
      [resolvedMod()],
      ['lithium-1.0.jar', 'sodium-1.0.jar', 'iris-3.0.jar'],
      PACK
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].installedFileName).toBe('sodium-1.0.jar');
  });

  it('omits the loader suffix from the failure reason when no loader is set', () => {
    const { failures } = compareResolvedWithInstalled(
      [resolvedMod({ bestFile: null })],
      [],
      { minecraftVersion: '1.20.1' }
    );

    expect(failures).toEqual([
      { id: 'mr:abc', reason: 'No compatible file found for Minecraft 1.20.1' },
    ]);
  });
});

describe('collectStaleModFileNames', () => {
  it('collects matched files except the current best file', () => {
    const stale = collectStaleModFileNames(
      [resolvedMod()],
      ['sodium-1.0.jar', 'sodium-2.0.jar', 'unrelated.jar']
    );

    expect(stale).toEqual(['sodium-1.0.jar']);
  });

  it('never returns names with separators or traversal, even if matched', () => {
    const evil = ['../evil.jar', 'a/b.jar', 'a\\b.jar', '..'];
    const stale = collectStaleModFileNames(
      [resolvedMod({ knownFileNames: [...evil, 'sodium-1.0.jar'] })],
      [...evil, 'sodium-1.0.jar']
    );

    expect(stale).toEqual(['sodium-1.0.jar']);
  });
});

describe('removeStaleModFiles', () => {
  it('removes listed files from the mods dir and leaves others alone', () => {
    const modsDir = makeModsDir(['sodium-1.0.jar', 'keep-me.jar']);

    removeStaleModFiles(modsDir, ['sodium-1.0.jar']);

    expect(fs.existsSync(path.join(modsDir, 'sodium-1.0.jar'))).toBe(false);
    expect(fs.existsSync(path.join(modsDir, 'keep-me.jar'))).toBe(true);
  });

  it('refuses to delete outside the mods dir via traversal names', () => {
    const modsDir = makeModsDir([]);
    const outsideFile = path.join(tmpDir, 'outside.jar');
    fs.writeFileSync(outsideFile, 'do not delete');

    removeStaleModFiles(modsDir, ['../outside.jar', '..\\outside.jar', '/outside.jar']);

    expect(fs.existsSync(outsideFile)).toBe(true);
  });
});

describe('listInstalledModFiles', () => {
  it('lists files only (no directories) and returns [] for missing dirs', () => {
    const modsDir = makeModsDir(['a.jar', 'b.zip']);
    fs.mkdirSync(path.join(modsDir, 'subdir'));

    expect(listInstalledModFiles(modsDir).sort()).toEqual(['a.jar', 'b.zip']);
    expect(listInstalledModFiles(path.join(tmpDir, 'nope'))).toEqual([]);
  });
});

describe('isSafeModFileName', () => {
  it('accepts ordinary mod file names', () => {
    expect(isSafeModFileName('sodium-fabric-0.5.8+mc1.20.1.jar')).toBe(true);
    expect(isSafeModFileName('Mod Name (1.20).jar')).toBe(true);
  });

  it('rejects separators, traversal, NUL bytes, and degenerate names', () => {
    expect(isSafeModFileName('a/b.jar')).toBe(false);
    expect(isSafeModFileName('a\\b.jar')).toBe(false);
    expect(isSafeModFileName('../evil.jar')).toBe(false);
    expect(isSafeModFileName('..')).toBe(false);
    expect(isSafeModFileName('.')).toBe(false);
    expect(isSafeModFileName('')).toBe(false);
    expect(isSafeModFileName('a\0b.jar')).toBe(false);
    expect(isSafeModFileName(42)).toBe(false);
    expect(isSafeModFileName('x'.repeat(256))).toBe(false);
  });
});

describe('pickBestFile', () => {
  const f = (id, fileDate, gameVersions) => ({
    id, fileName: `${id}.jar`, fileDate, downloadUrl: `https://example.invalid/${id}.jar`, gameVersions, dependencies: [],
  });

  it('prefers the newest file and filters rival-loader files', () => {
    const files = [
      f('1', '2024-03-01T00:00:00Z', ['1.20.1', 'NeoForge']),
      f('2', '2024-02-01T00:00:00Z', ['1.20.1', 'Forge']),
      f('3', '2024-01-01T00:00:00Z', ['1.20.1', 'Forge']),
    ];
    expect(pickBestFile(files, 'forge').id).toBe('2');
    expect(pickBestFile(files, undefined).id).toBe('1');
    expect(pickBestFile([], 'forge')).toBeNull();
  });

  it('falls back to the unfiltered list when every file looks rival-tagged', () => {
    const files = [f('1', '2024-01-01T00:00:00Z', ['1.20.1', 'Fabric'])];
    expect(pickBestFile(files, 'forge').id).toBe('1');
  });
});
