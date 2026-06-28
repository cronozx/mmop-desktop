export interface NotifiactionType {
  id: string,
  type: 'request' | 'alert';
  title: string;
  message: string;
  unread: boolean;
  modpack_Id?: string;
}

export interface ModType {
  _id?: string;
  name: string;
  author: string;
  game?: number;
  summary?: string;
  logo?: string;
  /** The mod's page on its source platform (Modrinth/Thunderstore/CurseForge). */
  sourceUrl?: string;
  /** The author's donation link (Ko-fi, Patreon, GitHub Sponsors, …), if set. */
  donationUrl?: string;
}

export interface GameType {
  id: number;
  name: string;
  modCount: number;
  imagePath: string;
  acceptedTypes: Record<string, unknown>;
  extensions: string;
  description: string;
  features?: {
    supportsVersionAndLoaderSelection?: boolean;
  };
}

export type ModLoaderType = 'forge' | 'neoforge' | 'fabric' | 'quilt';

export interface ModpackType {
  _id: string;
  name: string;
  description: string;
  gameID: number;
  author: string;
  contributers: { [userId: string]: boolean };
  mods: string[];
  /** Optional custom icon (a data: URL), set by Pro users; falls back to the game image. */
  icon?: string;
  minecraftVersion?: string;
  modLoader?: ModLoaderType;
  loaderVersion?: string;
  memoryAllocationMb?: number;
  /** Extra JVM arguments (whitespace-separated) applied on Minecraft launch. */
  customJvmArgs?: string;
  /** @deprecated Use modLoader + loaderVersion instead */
  forgeVersion?: string;
  proposedChanges?: {
    [userId: string]: {
      proposedMods: string[];
      timestamp: Date;
      status: 'pending' | 'approved' | 'rejected';
    }
  };
}

/** A modpack archive format MMOP can import. */
export type ModpackArchiveFormat = 'mrpack' | 'curseforge';

export interface ModpackImportUnresolvedEntry {
  path?: string;
  projectID?: number | string;
  reason: string;
}

/** Normalized result of parsing a .mrpack (no DB write). */
export interface ModpackImportDraft {
  name: string;
  description?: string;
  minecraftVersion: string;
  modLoader?: ModLoaderType;
  loaderVersion?: string;
  mods: string[];
  unresolved: ModpackImportUnresolvedEntry[];
  format: ModpackArchiveFormat;
}

export interface ModpackImportFileResult {
  success: boolean;
  canceled?: boolean;
  draft?: ModpackImportDraft;
  error?: string;
}

/** One mod that has a newer (or missing) file in the instance mods dir. */
export interface ModUpdateEntry {
  id: string;
  name: string;
  /** The matched on-disk file, or null when the mod is not installed. */
  installedFileName: string | null;
  latestFileName: string;
  latestFileDate: string;
}

export interface ModUpdateFailure {
  id: string;
  reason: string;
}

export interface ModUpdateCheckResult {
  checked: number;
  updates: ModUpdateEntry[];
  failures: ModUpdateFailure[];
}

export interface ModDownloadProgress {
  modpackId: string;
  completed: number;
  total: number;
  currentMod: string; // display name or id of mod currently downloading
}

export interface SmapiInstallProgress {
  stage: 'downloading' | 'extracting' | 'installing' | 'done';
  /** 0–100 during the download stage; omitted for indeterminate stages. */
  percent?: number;
}

/** A source a game's modpacks can be browsed from. */
export type ModpackProviderId = 'modrinth' | 'curseforge';

/** A modpack source plus its display label, for the browse UI's source picker. */
export interface ModpackProviderOption {
  id: ModpackProviderId;
  label: string;
}

/** A source a game's mods can be browsed from. */
export type ModProviderId = 'modrinth' | 'thunderstore' | 'steam' | 'curseforge';

/** A mod source plus its display label, for the Add Mods source picker. */
export interface ModProviderOption {
  id: ModProviderId;
  label: string;
}

/** An existing modpack found while browsing a provider (e.g. Modrinth). */
export interface ProviderModpackSummary {
  /** Provider-native project id (used to import the pack). */
  id: string;
  name: string;
  author: string;
  summary?: string;
  logo?: string;
  downloads?: number;
  provider: ModpackProviderId;
}

export interface ProviderModpackSearchResult {
  modpacks: ProviderModpackSummary[];
  hasMore: boolean;
  totalCount: number;
}

/** A modpack config root (a directory that holds editable config files). */
export interface ConfigRoot {
  /** Human-readable label for the UI (e.g. "Instance", "SMAPI Mods"). */
  label: string;
  dir: string;
}

/** One editable config file within a modpack's config roots. */
export interface ConfigFileEntry {
  /** Index into the roots array this file belongs to. */
  rootIndex: number;
  /** POSIX-style path relative to its root; the file's stable key. */
  relPath: string;
  /** File size in bytes. */
  size: number;
}

/** A mod's full long-form description, plus a canonical web URL when known. */
export interface ModDescription {
  description: string;
  /** Source markup of `description`; the renderer renders all variants safely as text. */
  format: 'markdown' | 'bbcode' | 'text';
  url?: string;
}

export interface ModCompatibilityResult {
  /** False when the provider lookup failed — callers should fail open. */
  checked: boolean;
  compatible: boolean;
}

// Shape returned by the users listing endpoints: only public fields are
// exposed; emails and notifications are private to their owner.
export type PublicUser = Pick<UserData, '_id' | 'username'>;

export interface UserData {
  _id?: string;
  username: string;
  email: string;
  password?: string;
  notifications: NotifiactionType[];
  oauth?: {
    github?: {
      id: string;
      linkedAt: string;
    };
    google?: {
      id: string;
      linkedAt: string;
    };
    microsoft?: {
      id: string;
      linkedAt: string;
    };
  };
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  notes?: string;
  error?: string;
}

export interface JWTPayload {
  userId: string;
  username: string;
}

export interface ContributionRequest {
  addedMods: string[],
  removedMods: string[],
  contributerId: string,
  status: 'pending' | 'approved' | 'rejected',
  timestamp: Date
}

/**
 * Pro subscription pricing for the upgrade UI, read live from the Stripe Price.
 * Amounts are in the smallest currency unit (e.g. cents). `compareAtAmount` is
 * an optional pre-sale price to strike through; `trialDays` an optional free
 * trial. All of these are controlled from the Stripe dashboard.
 */
export interface ProPricing {
  configured: boolean;
  amount: number | null;
  currency: string | null;
  interval: string | null;
  intervalCount: number | null;
  trialDays: number | null;
  compareAtAmount: number | null;
}

/**
 * Per-user Pro/subscription status for the upgrade UI. `trialEligible` is false
 * once the account has used its one free trial; `trialEndsAt` is the active/last
 * trial's end (ISO) for showing a countdown while `subscriptionStatus` is
 * "trialing".
 */
export interface ProStatus {
  isPro: boolean;
  configured: boolean;
  subscriptionStatus: string | null;
  trialEligible: boolean;
  trialEndsAt: string | null;
}