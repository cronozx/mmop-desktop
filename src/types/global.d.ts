/// <reference types="node" />

import { NotifiactionType, ModLoaderType, GameType, UpdateCheckResult, ModpackType, ModpackImportFileResult, ModUpdateCheckResult, ModCompatibilityResult, ModDescription, ProviderModpackSearchResult, ModpackProviderId, ModpackProviderOption, ModProviderId, ModProviderOption, ConfigRoot, ConfigFileEntry, ModDownloadProgress, SmapiInstallProgress, ProPricing, ProStatus } from "./sharedTypes";

interface DbAPI {
    checkForCustomUpdate: () => Promise<UpdateCheckResult>;
  isAuth0Enabled: () => Promise<boolean>;
  loginWithAuth0: (rememberMe?: boolean, promptLogin?: boolean) => Promise<{ success: boolean; error?: string }>;
  openVerificationWindow: (url: string) => Promise<void>;
  cancelAuth0Login: () => Promise<void>;
  getAllUsers: (token: string) => Promise<Pick<UserData, '_id' | 'username'>[] | null>;
  getAccountSettings: (token: string) => Promise<{ _id: string; username: string; email: string } | null>;
  getAuthToken: () => Promise<string | undefined>;
  getUserDataFromToken: () => Promise<{username: string, _id: string, passwordSet?: boolean, isPro?: boolean} | null>;
  getProStatus: () => Promise<ProStatus>;
  getProPricing: () => Promise<ProPricing>;
  startProCheckout: () => Promise<{ success: boolean; error?: string }>;
  validateAuthToken: (token: string) => Promise<boolean>;
  getSignInDiagnostic: () => Promise<string | null>;
  setAuth0Password: (password: string) => Promise<{ success: boolean; error?: string }>;
  updateAccountProfile: (fields: { username?: string; email?: string }) => Promise<{ success: boolean; error?: string }>;
  changeAccountPassword: (password: string) => Promise<{ success: boolean; error?: string; code?: string }>;
  getAccountIdentities: () => Promise<{ configured: boolean; identities: Array<{ provider: string; connection: string | null; userId: string; isSocial: boolean }>; reason?: string }>;
  unlinkAccountIdentity: (provider: string, userId: string) => Promise<{ success: boolean; error?: string }>;
  deleteAccount: () => Promise<{ success: boolean; error?: string }>;
  clearLogin: () => Promise<void>;
  getAllGames: (token: string) => Promise<GameType[]>;
  getPublicGames: () => Promise<GameType[]>;
  createModpack: (token: string, modpackinfo: ModpackType) => Promise<ModpackType | { error: string; code?: string } | null>;
  checkLoaderInstalled: (modLoader: ModLoaderType, minecraftVersion: string, loaderVersion: string) => Promise<boolean>;
  getAllModpacks: (token: string) => Promise<ModpackType[]>;
  updateModpack: (token: string, updatedModpack: ModpackType) => Promise<boolean>;
  deleteModpack: (token: string, modpackId: string) => Promise<boolean>;
  importModpackFile: () => Promise<ModpackImportFileResult>;
  getModpackProviders: (gameId: number) => Promise<ModpackProviderOption[]>;
  searchProviderModpacks: (gameId: number, provider?: ModpackProviderId, searchFilter?: string, pageIndex?: number, gameVersion?: string) => Promise<ProviderModpackSearchResult>;
  importProviderModpack: (gameId: number, provider: ModpackProviderId, modpackId: string) => Promise<ModpackImportFileResult>;
  getModProviders: (gameId: number) => Promise<ModProviderOption[]>;
  getAllModsForGame: (token: string, gameId: number, provider?: ModProviderId, searchFilter?: string, pageIndex?: number, gameVersion?: string, modLoader?: string) => Promise<{
    mods: Array<{_id: string, name: string, author: string, summary?: string, logo?: string}>;
    hasMore: boolean;
    totalCount: number;
  }>;
  getModsByIds: (token: string, modIds: string[]) => Promise<Array<{_id: string, name: string, author: string, summary?: string, logo?: string}>>;
  getNotifications: (token: string, _id: string) => Promise<NotifiactionType[]>;
  removeNotification: (token: string, notificationId) => Promise<void>;
  sendNotification: (token: string, _id: string, notification: NotifiactionType) => Promise<boolean>;
  markNotificationsAsRead: (token: string) => Promise<void>;
  handleAddContributerRequestAction: (token: string, modpack_Id: string, accepted: boolean) => Promise<void>;
  randUUID: () => Promise<string>;
  getGameExecutable: (gameId: number) => Promise<string | null>;
  getInstalledGameIds: () => Promise<number[]>;
  ensureGameExecutableOnFirstOpen: (gameId: number) => Promise<{ executable: string | null; shouldPrompt: boolean }>;
  getSmapiStatus: (gameId: number) => Promise<{ needed: boolean; installed: boolean }>;
  installSmapi: (gameId: number) => Promise<{ success: boolean; error?: string }>;
  onSmapiInstallProgress: (callback: (p: SmapiInstallProgress) => void) => () => void;
  selectAndSaveGameExecutable: (gameId: number) => Promise<string | null>;
  getDefaultMinecraftMemoryMb: () => Promise<number | null>;
  setDefaultMinecraftMemoryMb: (memoryMb: number) => Promise<{ success: boolean; error?: string; value?: number }>;
  installLoader: (modLoader: ModLoaderType, modpackName: string, minecraftVersion: string, loaderVersion: string) => Promise<{ success: boolean; step?: string; error?: string; profileId?: string; loaderVersionId?: string; gameDir?: string; profilesPath?: string }>;
  launchGame: (gameId: number, modpackName: string, memoryAllocationMb?: number, launchConfig?: { minecraftVersion?: string; modLoader?: string; loaderVersion?: string; customJvmArgs?: string }) => Promise<{ success: boolean; error?: string; authMode?: 'microsoft' | 'offline'; needsSmapi?: boolean }>;
  getMinecraftAccountStatus: () => Promise<{ signedIn: boolean; profileName?: string }>;
  signInMinecraftAccount: (step?: 'start' | 'wait') => Promise<{ success: boolean; userCode?: string; verificationUri?: string; profileName?: string; error?: string }>;
  signOutMinecraftAccount: () => Promise<{ success: boolean }>;
  getMissingModIds: (modpackName: string, modIds: string[], gameVersion?: string, modLoader?: string, gameId?: number) => Promise<string[]>;
  removeModFiles: (token: string, modIds: string[], modpackName: string, gameId?: number) => Promise<void>;
  downloadMods: (token: string, modIds: string[], modpackName: string, gameVersion?: string, modLoader?: string, gameId?: number) => Promise<{ successful: string[]; failed: string[]; skipped: string[]; dependencies: string[]; dependencyIds: string[]; downloadPath: string; deployedTo?: string }>;
  checkModUpdates: (token: string, modpackData: ModpackType) => Promise<ModUpdateCheckResult>;
  updateMods: (token: string, modpackData: ModpackType, modIds: string[]) => Promise<{ successful: string[]; failed: string[]; skipped: string[]; dependencies: string[]; downloadPath: string }>;
  onModDownloadProgress(callback: (p: ModDownloadProgress) => void): () => void;
  checkModCompatibility: (modId: string, gameVersion: string, modLoader?: string) => Promise<ModCompatibilityResult>;
  getModDescription: (modId: string) => Promise<ModDescription>;
  listConfigFiles: (modpackName: string, gameId: number) => Promise<{ roots: ConfigRoot[]; files: ConfigFileEntry[] }>;
  readConfigFile: (modpackName: string, gameId: number, rootIndex: number, relPath: string) => Promise<{ contents: string } | { error: string }>;
  writeConfigFile: (modpackName: string, gameId: number, rootIndex: number, relPath: string, contents: string) => Promise<{ success: boolean; error?: string }>;
  getMinecraftVersions: () => Promise<string[]>;
  getLoaderVersions: (modLoader: ModLoaderType, mcVersion: string) => Promise<string[]>;
  getAvailableLoaders: (mcVersion: string) => Promise<string[]>;
  minimizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<boolean>;
}

declare global {
  interface Window {
    db: DbAPI;
  }
}

export {};