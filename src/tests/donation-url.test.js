import { jest, afterEach, describe, it, expect } from '@jest/globals';
import {
  normalizeModrinthProject,
  modrinthAPI,
} from '../main/services/modrinth.js';

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// normalizeModrinthProject — pure function, donation_urls → donationUrl
// ---------------------------------------------------------------------------

describe('normalizeModrinthProject - donationUrl', () => {
  it('maps the first donation URL when present', () => {
    const result = normalizeModrinthProject(
      { id: 'AANobbMI', title: 'Sodium', donation_urls: [{ url: 'https://ko-fi.com/jellysquid' }] },
      'jellysquid3',
    );
    expect(result.donationUrl).toBe('https://ko-fi.com/jellysquid');
  });

  it('picks the first entry that has a url when there are multiple', () => {
    const result = normalizeModrinthProject({
      id: 'abc',
      title: 'Thing',
      donation_urls: [{}, { url: 'https://patreon.com/author' }, { url: 'https://ko-fi.com/author' }],
    });
    expect(result.donationUrl).toBe('https://patreon.com/author');
  });

  it('returns undefined when donation_urls is absent', () => {
    expect(normalizeModrinthProject({ id: 'abc', title: 'Thing' }).donationUrl).toBeUndefined();
  });

  it('returns undefined when donation_urls is an empty array', () => {
    expect(normalizeModrinthProject({ id: 'abc', title: 'Thing', donation_urls: [] }).donationUrl).toBeUndefined();
  });

  it('returns undefined when all donation_urls entries lack a url field', () => {
    expect(normalizeModrinthProject({ id: 'abc', title: 'Thing', donation_urls: [{}, {}] }).donationUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// modrinthAPI.searchMods — donation URL enrichment via getProjectsByIds
// ---------------------------------------------------------------------------

const fakeSearchResponse = (hits) => ({
  data: { hits, total_hits: hits.length },
});

describe('modrinthAPI.searchMods - donation URL enrichment', () => {
  it('populates donationUrl on mods that have a donation link', async () => {
    jest.spyOn(modrinthAPI['client'], 'get').mockResolvedValueOnce(
      fakeSearchResponse([{ project_id: 'AANobbMI', title: 'Sodium', author: 'jellysquid3' }]),
    );
    jest.spyOn(modrinthAPI, 'getProjectsByIds').mockResolvedValueOnce([
      { id: 'AANobbMI', title: 'Sodium', donation_urls: [{ url: 'https://ko-fi.com/jellysquid' }] },
    ]);

    const { mods } = await modrinthAPI.searchMods('sodium');

    expect(mods).toHaveLength(1);
    expect(mods[0].donationUrl).toBe('https://ko-fi.com/jellysquid');
  });

  it('leaves donationUrl undefined when the project has no donation links', async () => {
    jest.spyOn(modrinthAPI['client'], 'get').mockResolvedValueOnce(
      fakeSearchResponse([{ project_id: 'P7dR8mSH', title: 'Fabric API', author: 'modmuss50' }]),
    );
    jest.spyOn(modrinthAPI, 'getProjectsByIds').mockResolvedValueOnce([
      { id: 'P7dR8mSH', title: 'Fabric API' },
    ]);

    const { mods } = await modrinthAPI.searchMods('fabric');

    expect(mods[0].donationUrl).toBeUndefined();
  });

  it('handles a mix of mods with and without donation links', async () => {
    jest.spyOn(modrinthAPI['client'], 'get').mockResolvedValueOnce(
      fakeSearchResponse([
        { project_id: 'mod-a', title: 'Mod A', author: 'authorA' },
        { project_id: 'mod-b', title: 'Mod B', author: 'authorB' },
      ]),
    );
    jest.spyOn(modrinthAPI, 'getProjectsByIds').mockResolvedValueOnce([
      { id: 'mod-a', title: 'Mod A', donation_urls: [{ url: 'https://ko-fi.com/authorA' }] },
      { id: 'mod-b', title: 'Mod B' },
    ]);

    const { mods } = await modrinthAPI.searchMods();

    const modA = mods.find((m) => m._id === 'mr:mod-a');
    const modB = mods.find((m) => m._id === 'mr:mod-b');
    expect(modA.donationUrl).toBe('https://ko-fi.com/authorA');
    expect(modB.donationUrl).toBeUndefined();
  });

  it('skips enrichment and returns mods without donationUrl when getProjectsByIds returns nothing', async () => {
    jest.spyOn(modrinthAPI['client'], 'get').mockResolvedValueOnce(
      fakeSearchResponse([{ project_id: 'xyz', title: 'Unknown Mod', author: 'someone' }]),
    );
    jest.spyOn(modrinthAPI, 'getProjectsByIds').mockResolvedValueOnce([]);

    const { mods } = await modrinthAPI.searchMods();

    expect(mods[0].donationUrl).toBeUndefined();
  });
});
