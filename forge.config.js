import { FuseVersion, FuseV1Options } from '@electron/fuses';

const mainEntry = process.env.FORGE_MAIN_ENTRY || 'index.ts';

export default {
  packagerConfig: {
    asar: true,
    icon: './public/icon',
    name: 'MMOP',
    appBundleId: 'app.mmop.desktop',
    appCategoryType: 'public.app-category.utilities',
    executableName: 'MMOP',
    productName: 'MMOP',
    // Keep secrets and server/dev-only files out of the shipped asar. The app
    // runs from compiled `dist/` + `public/`; everything below is either secret
    // (.env), backend-only (server/, api/), or build/test tooling. Paths are
    // matched relative to the project root with a leading slash.
    ignore: (filePath) => {
      if (!filePath) return false;
      return (
        /^\/\.env($|\.|\/)/.test(filePath) ||
        /^\/(server|api|scripts|\.github|\.claude|\.vercel)(\/|$)/.test(filePath) ||
        /^\/src\/tests(\/|$)/.test(filePath) ||
        /^\/[^/]+\.md$/.test(filePath) ||
        /^\/(vercel\.json|\.vercelignore|tsconfig[^/]*\.json)$/.test(filePath)
      );
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'mmop',
        shortcutName: 'MMOP',
        setupIcon: './public/icon.ico',
        createDesktopShortcut: true,
      },
    },
    {
      // macOS distributable (.dmg). Works on Apple Silicon and Intel.
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'MMOP',
        icon: './public/icon.icns',
        overwrite: true,
      },
    },
    {
      // Cross-platform zip; the primary macOS artifact when not building a .dmg
      // and a convenient fallback elsewhere.
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-fuses',
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      },
    },
  ],
  hooks: {
    readPackageJson: async (_forgeConfig, packageJson) => {
      packageJson.main = mainEntry;
      return packageJson;
    },
  },
};