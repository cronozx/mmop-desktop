import { checkMinecraftVersionAvailability } from '../main/utils/minecraftVersionAvailability.js';

describe('Minecraft version availability', () => {
  it('reports the version as available when the list contains it', async () => {
    const result = await checkMinecraftVersionAvailability('1.21.1', async () => ({
      versions: [{ id: '1.21.1' }, { id: '1.20.6' }],
    }));

    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
    expect(result.resolvedVersionId).toBe('1.21.1');
    expect(result.error).toBe('');
  });

  it('reports a missing-version error when our data asks for a version that does not exist', async () => {
    const result = await checkMinecraftVersionAvailability('1.21.11', async () => ({
      versions: [{ id: '1.21.1' }, { id: '1.20.6' }],
    }));

    expect(result.available).toBe(false);
    expect(result.reason).toBe('missing-version');
    expect(result.error).toMatch(/1\.21\.11/);
  });

  it('reports a version-list-unavailable error when the version list cannot be fetched', async () => {
    const result = await checkMinecraftVersionAvailability('1.21.1', async () => {
      throw new Error('Version index unreachable');
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe('version-list-unavailable');
    expect(result.error).toMatch(/unreachable/i);
  });
});