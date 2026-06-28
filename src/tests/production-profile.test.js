import {
  assertBackendConfiguredForRuntime,
  normalizeBackendApiUrl,
} from '../main/utils/runtimeMode.js';

describe('Production Runtime Profile', () => {
  it('normalizes backend base URL', () => {
    expect(normalizeBackendApiUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(normalizeBackendApiUrl('   ')).toBeNull();
  });

  it('allows local fallback in non-production runtime', () => {
    expect(() =>
      assertBackendConfiguredForRuntime({
        nodeEnv: 'development',
        backendApiUrl: '',
        isPackaged: false,
      })
    ).not.toThrow();
  });

  it('allows production runtime when backend URL is missing and strict mode is disabled', () => {
    expect(() =>
      assertBackendConfiguredForRuntime({
        nodeEnv: 'production',
        backendApiUrl: '',
        isPackaged: false,
      })
    ).not.toThrow();
  });

  it('fails production runtime when backend URL is missing and strict mode is enabled', () => {
    expect(() =>
      assertBackendConfiguredForRuntime({
        nodeEnv: 'production',
        backendApiUrl: '',
        isPackaged: false,
        requireBackendApiInProduction: true,
      })
    ).toThrow(/BACKEND_API_URL/);
  });

  it('allows production runtime with backend URL configured', () => {
    expect(() =>
      assertBackendConfiguredForRuntime({
        nodeEnv: 'production',
        backendApiUrl: 'http://127.0.0.1:8787',
        isPackaged: true,
      })
    ).not.toThrow();
  });
});
