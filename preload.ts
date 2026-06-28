import { contextBridge, ipcRenderer } from 'electron';
import { UserData, NotifiactionType, GameType, UpdateCheckResult, ModpackType, ModpackImportFileResult, ModUpdateCheckResult, ModCompatibilityResult, ModDescription, ProviderModpackSearchResult, ModpackProviderId, ModpackProviderOption, ModProviderId, ModProviderOption, ConfigRoot, ConfigFileEntry, ModDownloadProgress, SmapiInstallProgress, ProPricing, ProStatus } from './src/types/sharedTypes';
import type { IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('db', {
  isAuth0Enabled: (): Promise<boolean> =>
    ipcRenderer.invoke('isAuth0Enabled'),
  loginWithAuth0: (rememberMe?: boolean, promptLogin?: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('loginWithAuth0', rememberMe, promptLogin),
  cancelAuth0Login: (): Promise<void> =>
    ipcRenderer.invoke('cancelAuth0Login'),
  openVerificationWindow: (url: string): Promise<void> =>
    ipcRenderer.invoke('openVerificationWindow', url),
  getAllUsers: (token: string): Promise<Pick<UserData, '_id' | 'username'>[] | null> =>
    ipcRenderer.invoke('getAllUsers', token),
  getAccountSettings: (token: string): Promise<{ _id: string; username: string; email: string } | null> =>
    ipcRenderer.invoke('getAccountSettings', token),
  getAuthToken: (): Promise<string | undefined> =>
    ipcRenderer.invoke('getAuthToken'),
  getUserDataFromToken: (): Promise<{username: string, _id: string, passwordSet?: boolean, isPro?: boolean} | null> =>
    ipcRenderer.invoke('getUserDataFromToken'),
  getProStatus: (): Promise<ProStatus> =>
    ipcRenderer.invoke('getProStatus'),
  getProPricing: (): Promise<ProPricing> =>
    ipcRenderer.invoke('getProPricing'),
  startProCheckout: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('startProCheckout'),
  validateAuthToken: (token: string): Promise<boolean> =>
    ipcRenderer.invoke('validateAuthToken', token),
  getSignInDiagnostic: (): Promise<string | null> =>
    ipcRenderer.invoke('getSignInDiagnostic'),
  setAuth0Password: (password: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('setAuth0Password', password),
  updateAccountProfile: (fields: { username?: string; email?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('updateAccountProfile', fields),
  changeAccountPassword: (password: string): Promise<{ success: boolean; error?: string; code?: string }> =>
    ipcRenderer.invoke('changeAccountPassword', password),
  getAccountIdentities: (): Promise<{ configured: boolean; identities: Array<{ provider: string; connection: string | null; userId: string; isSocial: boolean }>; reason?: string }> =>
    ipcRenderer.invoke('getAccountIdentities'),
  unlinkAccountIdentity: (provider: string, userId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('unlinkAccountIdentity', provider, userId),
  deleteAccount: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('deleteAccount'),
  clearLogin: (): Promise<void> => 
    ipcRenderer.invoke('clearLogin'),
  getAllGames: (token: string): Promise<GameType[]> => 
    ipcRenderer.invoke('getAllGames', token),
  getPublicGames: (): Promise<GameType[]> =>
    ipcRenderer.invoke('getPublicGames'),
  createModpack: (token: string, modpackinfo: ModpackType): Promise<ModpackType | null> =>
    ipcRenderer.invoke('createModpack', token, modpackinfo),
  checkLoaderInstalled: (modLoader: string, minecraftVersion: string, loaderVersion: string): Promise<boolean> =>
    ipcRenderer.invoke('checkLoaderInstalled', modLoader, minecraftVersion, loaderVersion),

  checkForCustomUpdate: (): Promise<UpdateCheckResult> =>
    ipcRenderer.invoke('checkForCustomUpdate'),
  getAllModpacks: (token: string): Promise<ModpackType[]> =>
    ipcRenderer.invoke('getAllModpacks', token),
  updateModpack: (token: string, updatedModpack: ModpackType): Promise<boolean> =>
    ipcRenderer.invoke('updateModpack', token, updatedModpack),
  deleteModpack: (token: string, modpackId: string): Promise<boolean> =>
    ipcRenderer.invoke('deleteModpack', token, modpackId),
  importModpackFile: (): Promise<ModpackImportFileResult> =>
    ipcRenderer.invoke('importModpackFile'),
  getModpackProviders: (gameId: number): Promise<ModpackProviderOption[]> =>
    ipcRenderer.invoke('getModpackProviders', gameId),
  searchProviderModpacks: (gameId: number, provider?: ModpackProviderId, searchFilter?: string, pageIndex?: number, gameVersion?: string): Promise<ProviderModpackSearchResult> =>
    ipcRenderer.invoke('searchProviderModpacks', gameId, provider, searchFilter, pageIndex, gameVersion),
  importProviderModpack: (gameId: number, provider: ModpackProviderId, modpackId: string): Promise<ModpackImportFileResult> =>
    ipcRenderer.invoke('importProviderModpack', gameId, provider, modpackId),
  getModProviders: (gameId: number): Promise<ModProviderOption[]> =>
    ipcRenderer.invoke('getModProviders', gameId),
  getAllModsForGame: (token: string, gameId: number, provider?: ModProviderId, searchFilter?: string, pageIndex?: number, gameVersion?: string, modLoader?: string): Promise<{
    mods: Array<{_id: string, name: string, author: string, summary?: string, logo?: string}>;
    hasMore: boolean;
    totalCount: number;
  }> =>
    ipcRenderer.invoke('getAllModsForGame', token, gameId, provider, searchFilter, pageIndex, gameVersion, modLoader),
  getModsByIds: (token: string, modIds: string[]): Promise<Array<{_id: string, name: string, author: string, summary?: string, logo?: string}>> =>
    ipcRenderer.invoke('getModsByIds', token, modIds),
  sendNotification: (token: string, _id: string, notification: NotifiactionType): Promise<boolean> => 
    ipcRenderer.invoke('sendNotification', token, _id, notification),
  getNotifications: (token: string, _id: string): Promise<NotifiactionType[]> =>
    ipcRenderer.invoke('getNotifications', token, _id),
  handleAddContributerRequestAction: (token: string, modpack_Id: string, accepted: boolean): Promise<void> => 
    ipcRenderer.invoke('handleAddContributerRequestAction', token, modpack_Id, accepted),
  removeNotification: (token: string, notificationId: string): Promise<void> =>
    ipcRenderer.invoke('removeNotification', token, notificationId),
  markNotificationsAsRead: (token: string): Promise<void> => 
    ipcRenderer.invoke('markNotificationsAsRead', token),
  randUUID: (): Promise<string> => ipcRenderer.invoke('randUUID'),
  getGameExecutable: (gameId: number): Promise<string | null> =>
    ipcRenderer.invoke('getGameExecutable', gameId),
  getInstalledGameIds: (): Promise<number[]> =>
    ipcRenderer.invoke('getInstalledGameIds'),
  ensureGameExecutableOnFirstOpen: (gameId: number): Promise<{ executable: string | null; shouldPrompt: boolean }> =>
    ipcRenderer.invoke('ensureGameExecutableOnFirstOpen', gameId),
  getSmapiStatus: (gameId: number): Promise<{ needed: boolean; installed: boolean }> =>
    ipcRenderer.invoke('getSmapiStatus', gameId),
  installSmapi: (gameId: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('installSmapi', gameId),
  onSmapiInstallProgress: (callback: (p: SmapiInstallProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: SmapiInstallProgress) => callback(p);
    ipcRenderer.on('smapiInstallProgress', listener);
    return () => ipcRenderer.removeListener('smapiInstallProgress', listener);
  },
  selectAndSaveGameExecutable: (gameId: number): Promise<string | null> =>
    ipcRenderer.invoke('selectAndSaveGameExecutable', gameId),
  getDefaultMinecraftMemoryMb: (): Promise<number | null> =>
    ipcRenderer.invoke('getDefaultMinecraftMemoryMb'),
  setDefaultMinecraftMemoryMb: (memoryMb: number): Promise<{ success: boolean; error?: string; value?: number }> =>
    ipcRenderer.invoke('setDefaultMinecraftMemoryMb', memoryMb),
  installLoader: (modLoader: string, modpackName: string, minecraftVersion: string, loaderVersion: string): Promise<{ success: boolean; step?: string; error?: string; profileId?: string; loaderVersionId?: string; gameDir?: string; profilesPath?: string }> =>
    ipcRenderer.invoke('installLoader', modLoader, modpackName, minecraftVersion, loaderVersion),
  launchGame: (gameId: number, modpackName: string, memoryAllocationMb?: number, launchConfig?: { minecraftVersion?: string; modLoader?: string; loaderVersion?: string; customJvmArgs?: string }): Promise<{ success: boolean; error?: string; authMode?: 'microsoft' | 'offline'; needsSmapi?: boolean }> =>
    ipcRenderer.invoke('launchGame', gameId, modpackName, memoryAllocationMb, launchConfig),
  getMinecraftAccountStatus: (): Promise<{ signedIn: boolean; profileName?: string }> =>
    ipcRenderer.invoke('getMinecraftAccountStatus'),
  signInMinecraftAccount: (step?: 'start' | 'wait'): Promise<{ success: boolean; userCode?: string; verificationUri?: string; profileName?: string; error?: string }> =>
    ipcRenderer.invoke('signInMinecraftAccount', step),
  signOutMinecraftAccount: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('signOutMinecraftAccount'),
  getMissingModIds: (modpackName: string, modIds: string[], gameVersion?: string, modLoader?: string, gameId?: number): Promise<string[]> =>
    ipcRenderer.invoke('getMissingModIds', modpackName, modIds, gameVersion, modLoader, gameId),
  removeModFiles: (token: string, modIds: string[], modpackName: string, gameId?: number): Promise<void> =>
    ipcRenderer.invoke('removeModFiles', token, modIds, modpackName, gameId),
  downloadMods: (token: string, modIds: string[], modpackName: string, gameVersion?: string, modLoader?: string, gameId?: number): Promise<{ successful: string[]; failed: string[]; skipped: string[]; dependencies: string[]; dependencyIds: string[]; downloadPath: string; deployedTo?: string }> =>
    ipcRenderer.invoke('downloadMods', token, modIds, modpackName, gameVersion, modLoader, gameId),
  checkModUpdates: (token: string, modpackData: ModpackType): Promise<ModUpdateCheckResult> =>
    ipcRenderer.invoke('checkModUpdates', token, modpackData),
  updateMods: (token: string, modpackData: ModpackType, modIds: string[]): Promise<{ successful: string[]; failed: string[]; skipped: string[]; dependencies: string[]; downloadPath: string }> =>
    ipcRenderer.invoke('updateMods', token, modpackData, modIds),
  onModDownloadProgress: (callback: (p: ModDownloadProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: ModDownloadProgress) => callback(p);
    ipcRenderer.on('modDownloadProgress', listener);
    return () => ipcRenderer.removeListener('modDownloadProgress', listener);
  },
  checkModCompatibility: (modId: string, gameVersion: string, modLoader?: string): Promise<ModCompatibilityResult> =>
    ipcRenderer.invoke('checkModCompatibility', modId, gameVersion, modLoader),
  getModDescription: (modId: string): Promise<ModDescription> =>
    ipcRenderer.invoke('getModDescription', modId),
  listConfigFiles: (modpackName: string, gameId: number): Promise<{ roots: ConfigRoot[]; files: ConfigFileEntry[] }> =>
    ipcRenderer.invoke('listConfigFiles', modpackName, gameId),
  readConfigFile: (modpackName: string, gameId: number, rootIndex: number, relPath: string): Promise<{ contents: string } | { error: string }> =>
    ipcRenderer.invoke('readConfigFile', modpackName, gameId, rootIndex, relPath),
  writeConfigFile: (modpackName: string, gameId: number, rootIndex: number, relPath: string, contents: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('writeConfigFile', modpackName, gameId, rootIndex, relPath, contents),
  getMinecraftVersions: (): Promise<string[]> =>
    ipcRenderer.invoke('getMinecraftVersions'),
  getLoaderVersions: (modLoader: string, mcVersion: string): Promise<string[]> =>
    ipcRenderer.invoke('getLoaderVersions', modLoader, mcVersion),
  getAvailableLoaders: (mcVersion: string): Promise<string[]> =>
    ipcRenderer.invoke('getAvailableLoaders', mcVersion),
  minimizeWindow: (): Promise<boolean> =>
    ipcRenderer.invoke('windowMinimize'),
  closeWindow: (): Promise<boolean> =>
    ipcRenderer.invoke('windowClose')
});