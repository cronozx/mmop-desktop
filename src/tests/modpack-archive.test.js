import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import {
  parseModpackArchive,
  normalizeMrpackIndex,
  normalizeCurseForgeManifest,
  isSafeArchivePath,
  ModpackImportError,
} from '../main/services/modpackImport.js';
import { normalizeVersionFilesResponse } from '../main/services/modrinth.js';

// Offline tests only — archives are built in memory with JSZip and the
// Modrinth hash lookup is injected as a stub resolver (no network).

const SHA1_A = 'a'.repeat(40);
const SHA1_B = 'b'.repeat(40);
const SHA1_C = 'c'.repeat(40);

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmop-archive-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let fileCounter = 0;
async function writeZipFixture(entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filePath = path.join(tmpDir, `fixture-${fileCounter++}.zip`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

const validMrpackIndex = (overrides = {}) => ({
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.0.0',
  name: 'Test Pack',
  summary: 'A test pack',
  files: [
    {
      path: 'mods/sodium.jar',
      hashes: { sha1: SHA1_A, sha512: 'f'.repeat(128) },
      downloads: ['https://cdn.modrinth.com/data/AANobbMI/sodium.jar'],
      fileSize: 1234,
    },
    {
      path: 'mods/unknown.jar',
      hashes: { sha1: SHA1_B },
      downloads: ['https://cdn.modrinth.com/data/xxx/unknown.jar'],
      fileSize: 99,
    },
  ],
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.3' },
  ...overrides,
});

const stubResolver = (map) => async (hashes, algorithm) => {
  expect(algorithm).toBe('sha1');
  const result = new Map();
  for (const hash of hashes) {
    if (map[hash]) result.set(hash, map[hash]);
  }
  return result;
};

describe('parseModpackArchive — .mrpack', () => {
  it('parses a valid mrpack and resolves mods via one batched hash lookup', async () => {
    const filePath = await writeZipFixture({
      'modrinth.index.json': JSON.stringify(validMrpackIndex()),
      'overrides/config/some.cfg': 'ignored',
    });

    let calls = 0;
    const resolver = async (hashes, algorithm) => {
      calls += 1;
      expect(algorithm).toBe('sha1');
      expect(hashes).toEqual(expect.arrayContaining([SHA1_A, SHA1_B]));
      return new Map([[SHA1_A, { projectId: 'AANobbMI', versionId: 'v1' }]]);
    };

    const draft = await parseModpackArchive(filePath, resolver);

    expect(calls).toBe(1);
    expect(draft.format).toBe('mrpack');
    expect(draft.name).toBe('Test Pack');
    expect(draft.description).toBe('A test pack');
    expect(draft.minecraftVersion).toBe('1.20.1');
    expect(draft.modLoader).toBe('fabric');
    expect(draft.loaderVersion).toBe('0.15.3');
    expect(draft.mods).toEqual(['mr:AANobbMI']);
    expect(draft.unresolved).toEqual([
      { path: 'mods/unknown.jar', reason: 'No matching Modrinth project for file hash' },
    ]);
  });

  it('maps every loader dependency key', () => {
    const cases = [
      [{ minecraft: '1.20.1', forge: '47.2.0' }, 'forge', '47.2.0'],
      [{ minecraft: '1.21.1', neoforge: '21.1.90' }, 'neoforge', '21.1.90'],
      [{ minecraft: '1.20.1', 'fabric-loader': '0.15.3' }, 'fabric', '0.15.3'],
      [{ minecraft: '1.20.1', 'quilt-loader': '0.21.0' }, 'quilt', '0.21.0'],
    ];
    for (const [dependencies, loader, version] of cases) {
      const { draft } = normalizeMrpackIndex(validMrpackIndex({ files: [], dependencies }));
      expect(draft.modLoader).toBe(loader);
      expect(draft.loaderVersion).toBe(version);
    }
  });

  it('marks traversal-style and non-mods paths unresolved without resolving them', async () => {
    const index = validMrpackIndex({
      files: [
        { path: '../../../evil.jar', hashes: { sha1: SHA1_A }, downloads: [], fileSize: 1 },
        { path: '/etc/passwd', hashes: { sha1: SHA1_B }, downloads: [], fileSize: 1 },
        { path: 'config/not-a-mod.toml', hashes: { sha1: SHA1_C }, downloads: [], fileSize: 1 },
      ],
    });
    const filePath = await writeZipFixture({ 'modrinth.index.json': JSON.stringify(index) });

    const resolver = jestStubNeverCalled();
    const draft = await parseModpackArchive(filePath, resolver.fn);

    expect(resolver.calls).toBe(0);
    expect(draft.mods).toEqual([]);
    expect(draft.unresolved).toEqual([
      { path: '../../../evil.jar', reason: 'Unsafe file path' },
      { path: '/etc/passwd', reason: 'Unsafe file path' },
      { path: 'config/not-a-mod.toml', reason: 'Not a mod file (only mods/ entries are imported)' },
    ]);
  });

  it('reports entries with missing sha1 or malformed shape as unresolved', () => {
    const index = validMrpackIndex({
      files: [
        { path: 'mods/no-hash.jar', downloads: [], fileSize: 1 },
        { path: 'mods/bad-hash.jar', hashes: { sha1: 'not-a-hash' }, fileSize: 1 },
        'not-an-object',
      ],
    });
    const { draft, hashEntries } = normalizeMrpackIndex(index);
    expect(hashEntries).toEqual([]);
    expect(draft.unresolved).toEqual([
      { path: 'mods/no-hash.jar', reason: 'Missing sha1 hash' },
      { path: 'mods/bad-hash.jar', reason: 'Malformed file entry' },
      { path: undefined, reason: 'Malformed file entry' },
    ]);
  });

  it('rejects an oversized name', async () => {
    const filePath = await writeZipFixture({
      'modrinth.index.json': JSON.stringify(validMrpackIndex({ name: 'x'.repeat(300) })),
    });
    await expect(parseModpackArchive(filePath, stubResolver({}))).rejects.toThrow(ModpackImportError);
  });

  it('rejects a missing minecraft dependency', () => {
    expect(() => normalizeMrpackIndex(validMrpackIndex({ dependencies: { 'fabric-loader': '0.15.3' } })))
      .toThrow(/Minecraft version/);
  });

  it('truncates over-long descriptions instead of rejecting', () => {
    const { draft } = normalizeMrpackIndex(validMrpackIndex({ files: [], summary: 'd'.repeat(5000) }));
    expect(draft.description).toHaveLength(2000);
  });

  it('fails the import when the hash lookup itself fails', async () => {
    const filePath = await writeZipFixture({
      'modrinth.index.json': JSON.stringify(validMrpackIndex()),
    });
    const failingResolver = async () => { throw new Error('network down'); };
    await expect(parseModpackArchive(filePath, failingResolver)).rejects.toThrow(/network down/);
  });
});

const validCurseForgeManifest = (overrides = {}) => ({
  manifestType: 'minecraftModpack',
  manifestVersion: 1,
  name: 'CF Test Pack',
  version: '1.2.0',
  author: 'someone',
  minecraft: {
    version: '1.20.1',
    modLoaders: [{ id: 'forge-47.2.0', primary: true }],
  },
  files: [
    { projectID: 238222, fileID: 4567890, required: true },
    { projectID: 306612, fileID: 1234567, required: true },
  ],
  overrides: 'overrides',
  ...overrides,
});

describe('parseModpackArchive — CurseForge manifest.json', () => {
  it('parses a valid CurseForge pack into cf: mod ids (no network)', async () => {
    const filePath = await writeZipFixture({
      'manifest.json': JSON.stringify(validCurseForgeManifest()),
      'overrides/config/some.cfg': 'ignored',
    });

    const draft = await parseModpackArchive(filePath, jestStubNeverCalled().fn);

    expect(draft.format).toBe('curseforge');
    expect(draft.name).toBe('CF Test Pack');
    expect(draft.minecraftVersion).toBe('1.20.1');
    expect(draft.modLoader).toBe('forge');
    expect(draft.loaderVersion).toBe('47.2.0');
    expect(draft.mods).toEqual(['cf:238222', 'cf:306612']);
    expect(draft.unresolved).toEqual([]);
  });

  it('parses each loader id prefix', () => {
    const cases = [
      ['forge-47.2.0', 'forge', '47.2.0'],
      ['neoforge-21.1.90', 'neoforge', '21.1.90'],
      ['fabric-0.15.3', 'fabric', '0.15.3'],
      ['quilt-0.21.0', 'quilt', '0.21.0'],
    ];
    for (const [id, loader, version] of cases) {
      const draft = normalizeCurseForgeManifest(validCurseForgeManifest({
        files: [],
        minecraft: { version: '1.20.1', modLoaders: [{ id, primary: true }] },
      }));
      expect(draft.modLoader).toBe(loader);
      expect(draft.loaderVersion).toBe(version);
    }
  });

  it('uses the primary loader when several are listed', () => {
    const draft = normalizeCurseForgeManifest(validCurseForgeManifest({
      files: [],
      minecraft: {
        version: '1.20.1',
        modLoaders: [{ id: 'fabric-0.15.3' }, { id: 'forge-47.2.0', primary: true }],
      },
    }));
    expect(draft.modLoader).toBe('forge');
  });

  it('marks malformed file entries unresolved without dropping the whole pack', () => {
    const draft = normalizeCurseForgeManifest(validCurseForgeManifest({
      files: [
        { projectID: 238222, fileID: 1, required: true },
        { fileID: 999 }, // missing projectID
        'not-an-object',
        { projectID: -5 }, // not positive
      ],
    }));
    expect(draft.mods).toEqual(['cf:238222']);
    expect(draft.unresolved).toEqual([
      { projectID: undefined, reason: 'Malformed file entry' },
      { projectID: undefined, reason: 'Malformed file entry' },
      { projectID: -5, reason: 'Malformed file entry' },
    ]);
  });

  it('rejects a manifest with no valid Minecraft version', () => {
    expect(() => normalizeCurseForgeManifest(validCurseForgeManifest({
      minecraft: { version: '', modLoaders: [] },
    }))).toThrow(ModpackImportError);
  });
});

function jestStubNeverCalled() {
  const state = { calls: 0 };
  state.fn = async () => {
    state.calls += 1;
    return new Map();
  };
  return state;
}

describe('parseModpackArchive — malformed archives', () => {
  it('rejects archives without a recognized manifest', async () => {
    const filePath = await writeZipFixture({ 'readme.txt': 'hello' });
    await expect(parseModpackArchive(filePath)).rejects.toThrow(/Not a recognized modpack archive/);
  });

  it('rejects malformed manifest JSON', async () => {
    const filePath = await writeZipFixture({ 'modrinth.index.json': '{ not json !!!' });
    await expect(parseModpackArchive(filePath)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects files that are not zip archives', async () => {
    const filePath = path.join(tmpDir, 'not-a-zip.mrpack');
    fs.writeFileSync(filePath, 'plain text, not a zip');
    await expect(parseModpackArchive(filePath)).rejects.toThrow(/could not open zip/);
  });

  it('rejects missing files', async () => {
    await expect(parseModpackArchive(path.join(tmpDir, 'does-not-exist.mrpack')))
      .rejects.toThrow(/could not be read/);
  });
});

describe('isSafeArchivePath', () => {
  it('accepts plain relative paths', () => {
    expect(isSafeArchivePath('mods/sodium.jar')).toBe(true);
    expect(isSafeArchivePath('mods/sub dir/mod-1.0+build.jar')).toBe(true);
  });

  it('rejects traversal, absolute, and windows-style paths', () => {
    expect(isSafeArchivePath('../evil.jar')).toBe(false);
    expect(isSafeArchivePath('mods/../../evil.jar')).toBe(false);
    expect(isSafeArchivePath('/etc/passwd')).toBe(false);
    expect(isSafeArchivePath('C:/windows/system32')).toBe(false);
    expect(isSafeArchivePath('mods\\evil.jar')).toBe(false);
    expect(isSafeArchivePath('mods//x.jar')).toBe(false);
    expect(isSafeArchivePath('')).toBe(false);
  });
});

describe('normalizeVersionFilesResponse', () => {
  it('maps hash → project/version ids and drops malformed entries', () => {
    const result = normalizeVersionFilesResponse({
      [SHA1_A]: { project_id: 'AANobbMI', id: 'v1' },
      [SHA1_B]: { project_id: '', id: 'v2' },
      [SHA1_C]: 'nonsense',
    });
    expect(result.get(SHA1_A)).toEqual({ projectId: 'AANobbMI', versionId: 'v1' });
    expect(result.has(SHA1_B)).toBe(false);
    expect(result.has(SHA1_C)).toBe(false);
  });

  it('returns an empty map for non-object payloads', () => {
    expect(normalizeVersionFilesResponse(null).size).toBe(0);
    expect(normalizeVersionFilesResponse([1, 2]).size).toBe(0);
    expect(normalizeVersionFilesResponse('x').size).toBe(0);
  });
});
