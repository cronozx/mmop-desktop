import dotenv from 'dotenv';
import { MongoClient, Collection, Db, ObjectId } from 'mongodb';
import argon2 from '@node-rs/argon2';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { deleteSecureValue, getSecureValue, hasSecureValue, setSecureValue } from '../utils/store.js';
import type { JWTPayload, ModDownloadProgress, ModpackType, NotifiactionType, UserData } from '../../types/sharedTypes.js';
import { modrinthAPI } from '../services/modrinth.js';
import { steamAPI } from '../services/steam.js';
import { downloadWorkshopItem, findTmodFile } from '../services/steamcmd.js';
import { readSteamManifest, writeSteamManifestEntry } from '../services/tmodloader.js';
import { curseforgeAPI } from '../services/curseforge.js';
import { getModProvider, getModSummariesByIds, parseModId, type ModProviderId } from '../services/modProvider.js';
import { getModProviders } from '../../config/games.js';
import { normalizeBackendApiUrl } from '../utils/runtimeMode.js';

dotenv.config();

const JWT_SECRET_ERROR = 'JWT_SECRET_KEY must be set in .env and be at least 32 characters';
const MONGO_URI_ERROR = 'MONGO_URI must be set in .env';

function getJwtSecret(): string {
    const jwtSecret = process.env.JWT_SECRET_KEY;
    if (!jwtSecret || jwtSecret.length < 32) {
        throw new Error(JWT_SECRET_ERROR);
    }

    return jwtSecret;
}

function getMongoUri(): string {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        throw new Error(MONGO_URI_ERROR);
    }

    return mongoUri;
}

let sessionAuthToken: string | undefined;
let sessionRefreshToken: string | undefined;

function persistAuthToken(token: string, rememberMe: boolean): void {
    sessionAuthToken = token;

    if (rememberMe) {
        setSecureValue('authToken', token);
    } else if (hasSecureValue('authToken')) {
        deleteSecureValue('authToken');
    }
}

function setAuthToken(token: string, rememberMe: boolean): void {
    persistAuthToken(token, rememberMe);
}

function persistRefreshToken(token: string, rememberMe: boolean): void {
    sessionRefreshToken = token;

    if (rememberMe) {
        setSecureValue('authRefreshToken', token);
    } else if (hasSecureValue('authRefreshToken')) {
        deleteSecureValue('authRefreshToken');
    }
}

function setRefreshToken(token: string, rememberMe: boolean): void {
    persistRefreshToken(token, rememberMe);
}

function getRefreshToken(): string | undefined {
    const persistedToken = getSecureValue('authRefreshToken');

    if (persistedToken) {
        sessionRefreshToken = persistedToken;
        return persistedToken;
    }

    return sessionRefreshToken;
}

function getAuthToken(): string | undefined {
    const persistedToken = getSecureValue('authToken');

    if (persistedToken) {
        sessionAuthToken = persistedToken;
        return persistedToken;
    }

    return sessionAuthToken;
}

function clearLogin(): void {
    sessionAuthToken = undefined;
    sessionRefreshToken = undefined;

    if (hasSecureValue('authToken')) {
        deleteSecureValue('authToken');
    }

    if (hasSecureValue('authRefreshToken')) {
        deleteSecureValue('authRefreshToken');
    }
}

let isConnected = false;
let client: MongoClient | null = null;

function getMongoClient(): MongoClient {
    if (!client) {
        client = new MongoClient(getMongoUri());
    }

    return client;
}

//General functions
async function connectDB(): Promise<MongoClient> {
    const mongoClient = getMongoClient();

    if (!isConnected) {
        await mongoClient.connect()
        isConnected = true
        console.log('Connected to MongoDB')
    }

    return mongoClient
}

async function disconnectDB(): Promise<void> {
    if (isConnected && client) {
        await client.close()
        isConnected = false
        client = null
        console.log('Disconnected from MongoDB')
    }
}

async function startQuery(collection: string): Promise<Collection> {
    const mongoClient = await connectDB()
    
    const database: Db = mongoClient.db("modmngr")
    return database.collection(collection)
}

//User functions
async function addUser(username: string, email: string, password: string): Promise<void> {
    if (!username || !email || !password) {
        throw new Error('Username, email, and password are required')
    }

    // Validate username: alphanumeric, underscores, hyphens, 3-30 chars
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
        throw new Error('Username must be 3-30 characters and contain only letters, numbers, underscores, or hyphens')
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Invalid email format')
    }

    // Validate password length
    if (password.length < 8 || password.length > 128) {
        throw new Error('Password must be between 8 and 128 characters')
    }

    const logins = await startQuery("logins")

    if (await logins.findOne({ username: username }) || await logins.findOne({ email: email })) {
        throw new Error('Username or email already exists')
    }

    const passwordHash = await argon2.hash(password)

    await logins.insertOne({
        username: username, 
        email: email,
        password: passwordHash,
        notifications: []
    })
}

async function removeUser(email: string, password: string): Promise<boolean> {
    if (!email || !password) {
        return false
    }

    const logins = await startQuery("logins")

    const userData = await logins.findOne({
        email: email
    }) as UserData | null

    if (!userData || !userData.password) {
        return false
    }

    const isValid = await argon2.verify(userData.password, password)
    
    if (isValid) {
        await logins.deleteOne({
            email: email
        })

        clearLogin();

        return true
    }
    
    return false
}

async function getUser(username: string | null = null, email: string | null = null): Promise<UserData | null> {
    const logins = await startQuery("logins")
    
    let userData: UserData | null = null

    if (username != null) {
        userData = await logins.findOne({
            username: username
        }) as UserData | null
    } else if (email != null) {
        userData = await logins.findOne({
            email: email
        }) as UserData | null
    }

    if (!userData) {
        return null
    }

    return {_id: userData._id, username: userData.username, email: userData.email, notifications: userData.notifications}
}

/** Internal-only: returns user with password hash for auth verification */
async function getUserWithPassword(username: string): Promise<UserData | null> {
    const logins = await startQuery("logins")
    const userData = await logins.findOne({ username }) as UserData | null;
    if (!userData) return null;
    return {_id: userData._id, username: userData.username, email: userData.email, password: userData.password, notifications: userData.notifications}
}

async function getAllUsers(token: string): Promise<Pick<UserData, '_id' | 'username'>[] | null> {
    if (!validateWebToken(token)) {
        return null;
    }

    const users = await startQuery('logins');
    // Only expose what the contributor picker needs; notifications are
    // private to their owner and must never be listed to other users.
    const userData = await users.find({}, { projection: { username: 1 } }).toArray()

    return userData.map(data => ({
        _id: data._id.toString(),
        username: data.username,
    }))
} 

// Rate limiting for login attempts
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60000; // 1 minute

async function validateUser(username: string, password: string, rememberMe: boolean = true): Promise<boolean> {
    if (!username || !password) {
        return false
    }

    // Check rate limiting
    const now = Date.now();
    const attempts = loginAttempts.get(username);
    if (attempts) {
        if (now - attempts.lastAttempt < LOGIN_LOCKOUT_MS && attempts.count >= MAX_LOGIN_ATTEMPTS) {
            throw new Error('Too many login attempts. Please try again later.');
        }
        if (now - attempts.lastAttempt >= LOGIN_LOCKOUT_MS) {
            loginAttempts.delete(username);
        }
    }

    const userData = await getUserWithPassword(username)
    
    if (!userData || !userData.password) {
        // Track failed attempt
        const prev = loginAttempts.get(username) || { count: 0, lastAttempt: now };
        loginAttempts.set(username, { count: prev.count + 1, lastAttempt: now });
        return false
    }

    if (await argon2.verify(userData.password, password)) {
        loginAttempts.delete(username); // Reset on success
        const token = jwt.sign({ 
            userId: userData._id,
            username: username 
        } as JWTPayload, getJwtSecret(), {
            expiresIn: '1h',
        });

        persistAuthToken(token, rememberMe);
        return true;
    } else {
        // Track failed attempt
        const prev = loginAttempts.get(username) || { count: 0, lastAttempt: now };
        loginAttempts.set(username, { count: prev.count + 1, lastAttempt: now });
        return false
    }
}

async function getAccountSettings(token: string): Promise<{
    _id: string;
    username: string;
    email: string;
    oauth: { github: boolean; google: boolean; microsoft: boolean };
} | null> {
    if (!validateWebToken(token)) {
        return null;
    }

    const userData = getUserDataFromToken();
    if (!userData?._id || !ObjectId.isValid(userData._id)) {
        return null;
    }

    try {
        const logins = await startQuery('logins');
        const user = await logins.findOne({ _id: new ObjectId(userData._id) }) as UserData | null;
        if (!user || !user._id || !user.email) {
            return null;
        }

        return {
            _id: user._id.toString(),
            username: user.username,
            email: user.email,
            oauth: {
                github: !!user.oauth?.github?.id,
                google: !!user.oauth?.google?.id,
                microsoft: !!user.oauth?.microsoft?.id,
            },
        };
    } catch {
        return null;
    }
}

function validateWebToken(token: string): boolean {
    if (!token) {
        return false;
    }

    try {
        jwt.verify(token, getJwtSecret());
        return true;
    } catch (_error) {
        clearLogin();
        
        return false;
    }
}

async function validateTokenForLocalOps(token: string): Promise<boolean> {
    if (!token) {
        return false;
    }

    const backendBaseUrl = normalizeBackendApiUrl(process.env.BACKEND_API_URL);
    if (backendBaseUrl) {
        try {
            let requestUrl = `${backendBaseUrl}/auth/validate`;
            for (let hop = 0; hop < 5; hop += 1) {
                const response = await axios.request({
                    method: 'GET',
                    url: requestUrl,
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                    timeout: 10000,
                    validateStatus: () => true,
                    maxRedirects: 0,
                });

                if ([301, 302, 307, 308].includes(response.status)) {
                    const location = response.headers?.location;
                    if (typeof location === 'string' && location.length > 0) {
                        requestUrl = new URL(location, requestUrl).toString();
                        continue;
                    }
                }

                return response.status === 200 && !!response.data?.valid;
            }

            return false;
        } catch {
            return false;
        }
    }

    return validateWebToken(token);
}

function getUserDataFromToken(): {username: string, _id: string} | null {
    const token = getAuthToken();
    
    if (!token) {
        return null;
    }
    
    try {
        const decoded = jwt.verify(token, getJwtSecret()) as unknown as JWTPayload;
        return { username: decoded.username, _id: decoded.userId };
    } catch (_error) {
        return null;
    }
}


//Notification functions
async function getNotifications(token: string, _id: string): Promise<NotifiactionType[]> {
    if (!validateWebToken(token)) {
        return [];
    }

    if (!ObjectId.isValid(_id)) return [];
    const objId = new ObjectId(_id)

    try {
        const users = await startQuery('logins');
        const user = await users.findOne({ _id: objId });

        if (!user) {
            return [];
        }

        return user.notifications;
    } catch (e) {
        console.log(`Error getting notifications ${e}`)
        return [];
    }
}

async function removeNotification(token: string, notificationId: string): Promise<void> {
    if (!validateWebToken(token)) {
        return;
    }

    const userId = getUserDataFromToken()?._id;
    if (!userId || !ObjectId.isValid(userId)) return;
    const objId = new ObjectId(userId);

    try {
        const users = await startQuery('logins');
        const user = await users.findOne({ _id: objId });

        if (!user) {
            return;
        }

        let notifications: NotifiactionType[] = user.notifications;
        notifications = notifications.filter(notification => notification.id !== notificationId);
        
        await users.updateOne({ _id: objId }, {$set: { notifications: notifications }})
    } catch (e) {
        console.log(`Error deleting notification ${e}`)
    }
}

async function sendNotification(token: string, _id: string, notification: NotifiactionType): Promise<boolean> {
    if (!validateWebToken(token)) {
        return false;
    }

    // Validate target user ID
    if (!ObjectId.isValid(_id)) return false;

    // Sanitize notification content
    const sanitizedNotification: NotifiactionType = {
        id: typeof notification.id === 'string' ? notification.id.slice(0, 100) : '',
        type: notification.type === 'request' || notification.type === 'alert' ? notification.type : 'alert',
        title: typeof notification.title === 'string' ? notification.title.slice(0, 200) : '',
        message: typeof notification.message === 'string' ? notification.message.slice(0, 1000) : '',
        unread: true,
        ...(notification.modpack_Id && typeof notification.modpack_Id === 'string' ? { modpack_Id: notification.modpack_Id.slice(0, 50) } : {}),
    };

    try {
        const objId = new ObjectId(_id)
        const users = await startQuery('logins');
        const user = await users.findOne({ _id: objId });
        
        if (!user) {
            return false;
        }

        const notifications = [sanitizedNotification, ...user.notifications];
        await users.updateOne({ _id: objId }, { $set: { notifications: notifications } });
        
        return true;
    } catch (e) {
        console.error('Could not send notification:', e);
        return false;
    }
}

async function markNotificationsAsRead(token: string): Promise<void> {
    if (!validateWebToken(token)) {
        return;
    }

    const userId = getUserDataFromToken()?._id;
    if (!userId || !ObjectId.isValid(userId)) return;
    const user_Id = new ObjectId(userId);

    const users = await startQuery('logins');
    const user = await users.findOne({ _id: user_Id });

    if (!user) {
        return;
    }

    const notifications: NotifiactionType[] = user.notifications.map((n: NotifiactionType) => ({ ...n, unread: false }));
    await users.updateOne({ _id: user_Id }, { $set: {notifications: notifications} })
}

async function handleAddContributerRequestAction(token: string, modpack_Id: string, accepted: boolean): Promise<void> {
    if (!validateWebToken(token)) {
        return;
    }

    const user_Id = getUserDataFromToken()?._id;
    if (!user_Id || !ObjectId.isValid(modpack_Id)) return;
    const objId = new ObjectId(modpack_Id);
    const modpack = await getModpack(objId);

    if (!modpack || !modpack.contributers || !user_Id) {
        return;
    }

    // Only users with a pending invite (entry present but not yet true) may
    // act on it; otherwise anyone could grant themselves contributor access.
    if (modpack.contributers[user_Id] !== false) {
        return;
    }

    const modpacks = await startQuery('modpacks');
    if (accepted) {
        await modpacks.updateOne(
            { _id: objId },
            { $set: { [`contributers.${user_Id}`]: true } }
        );
    } else {
        await modpacks.updateOne(
            { _id: objId },
            { $unset: { [`contributers.${user_Id}`]: "" } }
        );
    }
}

//Modpack functions
async function createModpack(token: string, modPackInfo: ModpackType): Promise<ModpackType | null> {
    if (!validateWebToken(token)) {
        return null;
    }

    return new Promise(async (resolve, reject) => {
        try {
            const modpacks = await startQuery('modpacks');
            const { _id, ...modpackData } = modPackInfo;
            const userData = getUserDataFromToken();
            if (!userData?.username) {
                resolve(null);
                return;
            }

            if (modpackData.contributers instanceof Map) {
                modpackData.contributers = Object.fromEntries(
                    Array.from(modpackData.contributers.entries()).map(([user, value]) => [user._id, value])
                );
            }

            // Always persist the author from the authenticated token, never client payload.
            modpackData.author = userData.username;

            const result = await modpacks.insertOne(modpackData);
            const created = await getModpack(result.insertedId);
            resolve(created);
        } catch {
            reject(null)
        }
    })
}

async function getUsersModpacks(token: string): Promise<ModpackType[]> {
    if (!validateWebToken(token)) {
        return [];
    }

    try {
        const userData = getUserDataFromToken();
        if (!userData?.username || !userData?._id) {
            return [];
        }

        const modpacks = await startQuery('modpacks');
        const docs = await modpacks.find({
            $or: [
                { author: userData.username },
                { [`contributers.${userData._id}`]: true },
            ],
        }).toArray();

        const modpacksList = await Promise.all(docs.map(async doc => getModpack(doc._id)));
        return modpacksList.filter((modpack): modpack is ModpackType => modpack !== null);
    } catch (error) {
        console.error('Failed to retrieve modpacks:', error);
        return [];
    }
}

async function getModpack(_id: ObjectId): Promise<ModpackType | null> {
    const modpacks = await startQuery('modpacks');
    const doc = await modpacks.findOne({ _id: _id });

    if (!doc) {
        return null;
    }
    const contributers: { [userId: string]: boolean } = Object.fromEntries(Object.entries(doc.contributers ?? {}));
    const proposedChanges: { [userId: string]: {
      proposedMods: string[];
      timestamp: Date;
      status: 'pending' | 'approved' | 'rejected';
    }} = Object.fromEntries(Object.entries(doc.proposedChanges ?? {}));

    return {
        _id: doc._id.toString(),
        name: doc.name,
        description: doc.description,
        gameID: Number(doc.gameID),
        author: doc.author,
        contributers: contributers,
        mods: doc.mods,
        proposedChanges: proposedChanges,
        ...(doc.minecraftVersion !== undefined && { minecraftVersion: doc.minecraftVersion }),
        ...(doc.modLoader !== undefined && { modLoader: doc.modLoader }),
        ...(doc.loaderVersion !== undefined && { loaderVersion: doc.loaderVersion }),
        ...(doc.memoryAllocationMb !== undefined && { memoryAllocationMb: doc.memoryAllocationMb }),
        ...(doc.forgeVersion !== undefined && { forgeVersion: doc.forgeVersion }),
    }
}

async function getModpackByNameForCurrentUser(modpackName: string): Promise<ModpackType | null> {
    const normalizedName = typeof modpackName === 'string' ? modpackName.trim() : '';
    if (!normalizedName) {
        return null;
    }

    const userData = getUserDataFromToken();
    if (!userData?._id || !userData.username || !ObjectId.isValid(userData._id)) {
        return null;
    }

    const modpacks = await startQuery('modpacks');
    const doc = await modpacks.findOne({
        name: normalizedName,
        $or: [
            { author: userData.username },
            { [`contributers.${userData._id}`]: true },
        ],
    });

    if (!doc?._id) {
        return null;
    }

    return await getModpack(doc._id);
}

async function updateModpack(token: string, updatedModpack: ModpackType): Promise<boolean> {
    if (!validateWebToken(token)) {
        return false;
    }

    try {
        const modpacks = await startQuery('modpacks');
        const { _id: modpackId, ...updatedModpackData } = updatedModpack;
    
        if (!ObjectId.isValid(modpackId)) return false;

        // Verify the current user is the author or an approved contributor
        const userData = getUserDataFromToken();
        if (!userData) return false;
        const existing = await modpacks.findOne({ _id: new ObjectId(modpackId) });
        if (!existing) return false;
        const isAuthor = existing.author === userData.username;
        const isContributor = existing.contributers?.[userData._id] === true;
        if (!isAuthor && !isContributor) return false;

        // Whitelist allowed fields to prevent overwriting protected fields like author
        const allowedFields = ['name', 'description', 'mods', 'contributers', 'minecraftVersion', 'modLoader', 'loaderVersion', 'memoryAllocationMb', 'forgeVersion', 'proposedChanges'];
        const safeUpdate = Object.fromEntries(
            Object.entries(updatedModpackData).filter(([k]) => allowedFields.includes(k))
        );

        const res = await modpacks.updateOne({ _id: new ObjectId(modpackId) }, { $set: safeUpdate });
        return res.modifiedCount > 0;
    } catch (error) {
        console.error('Failed to update modpack:', error);
        return false;
    }
}

async function deleteModpack(token: string, modpackId: string): Promise<string | false> {
    if (!validateWebToken(token)) {
        return false;
    }

    try {
        if (!ObjectId.isValid(modpackId)) return false;

        const modpacks = await startQuery('modpacks');
        const doc = await modpacks.findOne({ _id: new ObjectId(modpackId) });
        if (!doc) return false;

        // Verify the current user is the author
        const userData = getUserDataFromToken();
        if (!userData || doc.author !== userData.username) return false;

        const res = await modpacks.deleteOne({ _id: new ObjectId(modpackId) });
        return res.deletedCount > 0 ? (doc.name as string) : false;
    } catch (error) {
        console.error('Failed to delete modpack:', error);
        return false;
    }
}

//Mod functions
async function getAllModsForGame(
    token: string,
    gameId: number,
    requestedProvider?: ModProviderId,
    searchFilter?: string,
    pageIndex?: number,
    gameVersion?: string,
    modLoader?: string
): Promise<{
    mods: Array<{_id: string, name: string, author: string, summary?: string, logo?: string}>;
    hasMore: boolean;
    totalCount: number;
}> {
    if (!validateWebToken(token)) {
        return { mods: [], hasMore: false, totalCount: 0 };
    }

    try {
        console.log('getAllModsForGame called with gameId:', gameId, 'provider:', requestedProvider, 'search:', searchFilter, 'page:', pageIndex);

        // A game can have several mod sources (Minecraft → Modrinth + CurseForge);
        // honor the requested one when the game supports it, else use the game's
        // default (the first available). Empty list → no mod source for this game.
        const available = getModProviders(gameId);
        const providerId = available.find((p) => p.id === requestedProvider)?.id ?? available[0]?.id;
        if (!providerId) {
            return { mods: [], hasMore: false, totalCount: 0 };
        }
        const provider = getModProvider(providerId);
        const result = await provider.search(gameId, searchFilter, pageIndex || 0, 50, gameVersion, modLoader);
        console.log('getAllModsForGame returning', result.mods.length, 'mods, hasMore:', result.pagination.hasMore);
        return {
            mods: result.mods,
            hasMore: result.pagination.hasMore,
            totalCount: result.pagination.totalCount,
        };
    } catch (error) {
        console.error('Error fetching mods:', error);
        return { mods: [], hasMore: false, totalCount: 0 };
    }
}

async function getModsByIds(
    token: string,
    modIds: string[]
): Promise<Array<{_id: string, name: string, author: string, summary?: string, logo?: string}>> {
    if (!validateWebToken(token)) {
        return [];
    }

    try {
        // Prefixed (mr:/ts:) ids are split by provider, fetched, and merged.
        // Returned `_id`s match the input ids.
        return await getModSummariesByIds(modIds);
    } catch (error) {
        console.error('Error fetching mods by IDs:', error);
        return [];
    }
}

//Mod download functions

async function downloadMods(
    token: string,
    modIds: string[],
    downloadPath: string,
    gameVersion?: string,
    modLoader?: string,
    onProgress?: (p: ModDownloadProgress) => void
): Promise<{ successful: string[]; failed: string[]; skipped: string[]; dependencies: string[]; dependencyIds: string[] }> {
    if (!(await validateTokenForLocalOps(token))) {
        return { successful: [], failed: modIds, skipped: [], dependencies: [], dependencyIds: [] };
    }

    // Split the (possibly mixed) id list by provider. `mr:`/`ts:` prefixes
    // select the provider explicitly.
    const modrinthInitialIds: string[] = [];
    const thunderstoreInitialIds: string[] = [];
    const steamInitialIds: string[] = [];
    const curseforgeInitialIds: string[] = [];
    for (const rawId of modIds) {
        const parsed = parseModId(rawId);
        if (parsed?.provider === 'modrinth') {
            modrinthInitialIds.push(parsed.id);
        } else if (parsed?.provider === 'thunderstore') {
            thunderstoreInitialIds.push(parsed.id);
        } else if (parsed?.provider === 'steam') {
            steamInitialIds.push(parsed.id);
        } else if (parsed?.provider === 'curseforge') {
            curseforgeInitialIds.push(parsed.id);
        }
    }

    if (modrinthInitialIds.length === 0 && thunderstoreInitialIds.length === 0 && steamInitialIds.length === 0 && curseforgeInitialIds.length === 0) {
        return { successful: [], failed: modIds, skipped: [], dependencies: [], dependencyIds: [] };
    }

    const successful: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const dependencyNames: string[] = [];
    // Provider-prefixed ids of auto-resolved dependencies, so the caller can add
    // them to the modpack's mod list (they were downloaded but not user-selected).
    const dependencyIds: string[] = [];

    // Progress is reported only for the top-level (user-requested) mods, not the
    // recursively resolved dependencies.
    const progressTotal = modrinthInitialIds.length + thunderstoreInitialIds.length + steamInitialIds.length + curseforgeInitialIds.length;
    let progressCompleted = 0;
    const reportProgress = (currentMod: string) => {
        progressCompleted += 1;
        onProgress?.({ modpackId: '', completed: progressCompleted, total: progressTotal, currentMod });
    };

    // ── Modrinth downloads ──────────────────────────────────────────────────
    // Queue semantics: first round = requested mods, later rounds = recursively
    // resolved required dependencies (same provider).
    const modrinthLoader = modLoader ? modLoader.toLowerCase() : undefined;
    const modrinthProcessedIds = new Set<string>(modrinthInitialIds);
    const modrinthQueue: string[] = [...modrinthInitialIds];
    let isModrinthDepRound = false;

    while (modrinthQueue.length > 0) {
        const batchIds = modrinthQueue.splice(0, modrinthQueue.length);
        const projects = await modrinthAPI.getProjectsByIds(batchIds);
        const titlesById = new Map(projects.map((project) => [project.id, project.title]));

        for (const projectId of batchIds) {
            const modName = titlesById.get(projectId) ?? projectId;

            // The version endpoint already filters by gameVersion + loader and
            // returns newest first: take the first result's primary file.
            const candidateFiles = await modrinthAPI.getFilesForMod(projectId, gameVersion, modrinthLoader);
            const latestFile = candidateFiles[0];

            if (!latestFile?.downloadUrl) {
                failed.push(modName);
                continue;
            }

            const filePath = path.join(downloadPath, latestFile.fileName);

            if (fs.existsSync(filePath)) {
                skipped.push(modName);
            } else {
                // Remove stale files left over from this project's other versions
                for (const file of candidateFiles) {
                    if (file.fileName === latestFile.fileName) continue;
                    const stalePath = path.join(downloadPath, file.fileName);
                    if (fs.existsSync(stalePath)) {
                        try { fs.unlinkSync(stalePath); } catch {}
                    }
                }

                try {
                    const response = await axios.get(latestFile.downloadUrl, { responseType: 'arraybuffer' });
                    fs.writeFileSync(filePath, response.data);
                    if (isModrinthDepRound) {
                        dependencyNames.push(modName);
                    } else {
                        successful.push(modName);
                    }
                } catch (error) {
                    console.error(`Failed to download ${modName}:`, error);
                    failed.push(modName);
                    continue;
                }
            }

            if (isModrinthDepRound) dependencyIds.push(`mr:${projectId}`);

            // Enqueue required dependencies (same provider) not yet processed
            for (const dep of latestFile.dependencies) {
                if (!dep.required) continue;
                const parsedDep = parseModId(dep.modId);
                if (parsedDep?.provider === 'modrinth' && !modrinthProcessedIds.has(parsedDep.id)) {
                    modrinthProcessedIds.add(parsedDep.id);
                    modrinthQueue.push(parsedDep.id);
                }
            }

            if (!isModrinthDepRound) reportProgress(modName);
        }

        isModrinthDepRound = true;
    }

    // ── Thunderstore downloads ──────────────────────────────────────────────
    // BepInEx packages: each package's latest version is a single zip, saved
    // flat into the instance dir (the IPC layer extracts it into the game's
    // BepInEx layout on deploy). Required dependencies (e.g. the BepInEx pack
    // itself) are resolved recursively, same as the other providers.
    const thunderstoreProvider = getModProvider('thunderstore');
    const thunderstoreProcessedIds = new Set<string>(thunderstoreInitialIds);
    const thunderstoreQueue: string[] = [...thunderstoreInitialIds];
    let isThunderstoreDepRound = false;

    while (thunderstoreQueue.length > 0) {
        const batchIds = thunderstoreQueue.splice(0, thunderstoreQueue.length);
        const summaries = await thunderstoreProvider.getModsByIds(batchIds);
        const namesByNativeId = new Map(
            summaries.map((summary) => [parseModId(summary._id)?.id ?? summary._id, summary.name])
        );

        for (const nativeId of batchIds) {
            const modName = namesByNativeId.get(nativeId) ?? nativeId;

            const candidateFiles = await thunderstoreProvider.getFilesForMod(nativeId);
            const latestFile = candidateFiles[0];

            if (!latestFile?.downloadUrl) {
                failed.push(modName);
                continue;
            }

            const filePath = path.join(downloadPath, latestFile.fileName);

            if (fs.existsSync(filePath)) {
                skipped.push(modName);
            } else {
                try {
                    const response = await axios.get(latestFile.downloadUrl, { responseType: 'arraybuffer' });
                    fs.writeFileSync(filePath, response.data);
                    if (isThunderstoreDepRound) {
                        dependencyNames.push(modName);
                    } else {
                        successful.push(modName);
                    }
                } catch (error) {
                    console.error(`Failed to download ${modName}:`, error);
                    failed.push(modName);
                    continue;
                }
            }

            if (isThunderstoreDepRound) dependencyIds.push(`ts:${nativeId}`);

            // Enqueue required dependencies (same provider) not yet processed.
            for (const dep of latestFile.dependencies) {
                if (!dep.required) continue;
                const parsedDep = parseModId(dep.modId);
                if (parsedDep?.provider === 'thunderstore' && !thunderstoreProcessedIds.has(parsedDep.id)) {
                    thunderstoreProcessedIds.add(parsedDep.id);
                    thunderstoreQueue.push(parsedDep.id);
                }
            }

            if (!isThunderstoreDepRound) reportProgress(modName);
        }

        isThunderstoreDepRound = true;
    }

    // ── Steam Workshop downloads (Terraria / tModLoader) ────────────────────
    // The Web API can't serve UGC files, so each item is fetched via SteamCMD,
    // which writes it to a per-item folder; the `.tmod` is copied into the
    // instance dir under its real name (tModLoader matches mods by file name).
    // No dependency graph is exposed, so each requested item stands alone.
    if (steamInitialIds.length > 0) {
        const summaries = await steamAPI.getModsByIds(steamInitialIds);
        const namesByNativeId = new Map(
            summaries.map((summary) => [parseModId(summary._id)?.id ?? summary._id, summary.name])
        );

        for (const nativeId of steamInitialIds) {
            const modName = namesByNativeId.get(nativeId) ?? nativeId;
            const [appIdRaw, pubFileId] = nativeId.split('/');
            const appId = Number(appIdRaw);
            if (!appId || !pubFileId) {
                failed.push(modName);
                reportProgress(modName);
                continue;
            }

            // Already downloaded for this pack? (tracked by the steam manifest).
            const existingName = readSteamManifest(downloadPath)[`sw:${nativeId}`];
            if (existingName && fs.existsSync(path.join(downloadPath, existingName))) {
                skipped.push(modName);
                reportProgress(modName);
                continue;
            }

            const result = await downloadWorkshopItem(appId, pubFileId);
            if ('error' in result) {
                console.error(`Failed to download Steam Workshop item ${nativeId}:`, result.error);
                failed.push(modName);
                reportProgress(modName);
                continue;
            }

            const tmodPath = findTmodFile(result.dir);
            if (!tmodPath) {
                console.error(`Steam Workshop item ${nativeId} contained no .tmod file.`);
                failed.push(modName);
                reportProgress(modName);
                continue;
            }

            try {
                const fileName = path.basename(tmodPath);
                fs.copyFileSync(tmodPath, path.join(downloadPath, fileName));
                writeSteamManifestEntry(downloadPath, `sw:${nativeId}`, fileName);
                successful.push(modName);
            } catch (error) {
                console.error(`Failed to copy Steam Workshop mod ${nativeId}:`, error);
                failed.push(modName);
            }
            reportProgress(modName);
        }
    }

    // ── CurseForge downloads ────────────────────────────────────────────────
    // Mirror of the Modrinth flow: version/loader-aware, with required
    // dependencies resolved recursively. Files download straight from
    // CurseForge's CDN — never re-hosted. A file with no download url (the
    // author opted out of third-party distribution) is reported as failed
    // rather than worked around.
    const curseforgeLoader = modLoader ? modLoader.toLowerCase() : undefined;
    const curseforgeProcessedIds = new Set<string>(curseforgeInitialIds);
    const curseforgeQueue: string[] = [...curseforgeInitialIds];
    let isCurseforgeDepRound = false;

    while (curseforgeQueue.length > 0) {
        const batchIds = curseforgeQueue.splice(0, curseforgeQueue.length);
        const mods = await curseforgeAPI.getModsByIds(batchIds);
        const namesById = new Map(mods.map((mod) => [mod._id, mod.name]));

        for (const modId of batchIds) {
            const modName = namesById.get(modId) ?? modId;

            const candidateFiles = await curseforgeAPI.getFilesForMod(modId, gameVersion, curseforgeLoader);
            const latestFile = candidateFiles[0];

            if (!latestFile?.downloadUrl) {
                failed.push(modName);
                continue;
            }

            const filePath = path.join(downloadPath, latestFile.fileName);
            if (fs.existsSync(filePath)) {
                skipped.push(modName);
            } else {
                // Remove stale files left over from this mod's other versions.
                for (const file of candidateFiles) {
                    if (file.fileName === latestFile.fileName) continue;
                    const stalePath = path.join(downloadPath, file.fileName);
                    if (fs.existsSync(stalePath)) {
                        try { fs.unlinkSync(stalePath); } catch {}
                    }
                }
                try {
                    const response = await axios.get(latestFile.downloadUrl, { responseType: 'arraybuffer' });
                    fs.writeFileSync(filePath, response.data);
                    if (isCurseforgeDepRound) {
                        dependencyNames.push(modName);
                    } else {
                        successful.push(modName);
                    }
                } catch (error) {
                    console.error(`Failed to download ${modName}:`, error);
                    failed.push(modName);
                    continue;
                }
            }

            if (isCurseforgeDepRound) dependencyIds.push(`cf:${modId}`);

            // Enqueue required dependencies (same provider) not yet processed.
            for (const dep of latestFile.dependencies) {
                if (!dep.required) continue;
                const parsedDep = parseModId(dep.modId);
                if (parsedDep?.provider === 'curseforge' && !curseforgeProcessedIds.has(parsedDep.id)) {
                    curseforgeProcessedIds.add(parsedDep.id);
                    curseforgeQueue.push(parsedDep.id);
                }
            }

            if (!isCurseforgeDepRound) reportProgress(modName);
        }

        isCurseforgeDepRound = true;
    }

    return { successful, failed, skipped, dependencies: dependencyNames, dependencyIds: Array.from(new Set(dependencyIds)) };
}

/**
 * Resolves the known on-disk file names for each mod id (across providers),
 * grouped by the original id. Throws on a provider error so callers can decide
 * how to treat an unverifiable result.
 */
async function resolveModFilesByMod(modIds: string[], downloadPath?: string): Promise<Map<string, string[]>> {
    const modrinth: Array<{ raw: string; id: string }> = [];
    const thunderstore: Array<{ raw: string; id: string }> = [];
    const steam: string[] = [];
    const curseforge: Array<{ raw: string; id: string }> = [];
    for (const raw of modIds) {
        const parsed = parseModId(raw);
        if (parsed?.provider === 'modrinth') {
            modrinth.push({ raw, id: parsed.id });
        } else if (parsed?.provider === 'thunderstore') {
            thunderstore.push({ raw, id: parsed.id });
        } else if (parsed?.provider === 'steam') {
            steam.push(raw);
        } else if (parsed?.provider === 'curseforge') {
            curseforge.push({ raw, id: parsed.id });
        }
    }

    const filesByMod = new Map<string, string[]>();
    // Steam Workshop file names aren't derivable from the id; the instance
    // manifest records the real .tmod name written at download time.
    if (steam.length > 0 && downloadPath) {
        const manifest = readSteamManifest(downloadPath);
        for (const raw of steam) {
            const fileName = manifest[raw];
            filesByMod.set(raw, fileName ? [fileName] : []);
        }
    }
    for (const c of curseforge) {
        const files = await curseforgeAPI.getFilesForMod(c.id);
        filesByMod.set(c.raw, files.map((f) => f.fileName));
    }
    for (const m of modrinth) {
        const files = await modrinthAPI.getFilesForMod(m.id);
        filesByMod.set(m.raw, files.map((f) => f.fileName));
    }
    if (thunderstore.length > 0) {
        const thunderstoreProvider = getModProvider('thunderstore');
        for (const t of thunderstore) {
            const files = await thunderstoreProvider.getFilesForMod(t.id);
            filesByMod.set(t.raw, files.map((f) => f.fileName));
        }
    }
    return filesByMod;
}

/**
 * Resolves the on-disk file names a set of mod ids map to (every known file for
 * each mod, across providers). Used to delete a mod's downloaded files, and by
 * the IPC layer to find a mod's deployed artifacts in a game folder.
 */
async function resolveModFileNames(modIds: string[], downloadPath?: string): Promise<string[]> {
    try {
        return [...(await resolveModFilesByMod(modIds, downloadPath)).values()].flat();
    } catch (error) {
        console.error('Error resolving mod file names:', error);
        return [];
    }
}

/**
 * Returns the mod ids whose files are not present in `downloadPath` — i.e. the
 * mods still needing a download. Resolves candidate files the SAME way
 * downloadMods does (version/loader-filtered for Modrinth) so a mod the download
 * already wrote is recognized as present. A mod with no resolvable files is
 * treated as present (can't judge); on a provider error all ids are returned, so
 * the UI errs toward offering a download rather than hiding it.
 */
async function findMissingModIds(
    modIds: string[],
    downloadPath: string,
    gameVersion?: string,
    modLoader?: string,
): Promise<string[]> {
    if (modIds.length === 0) return [];
    try {
        const onDisk = fs.existsSync(downloadPath) ? new Set(fs.readdirSync(downloadPath)) : new Set<string>();
        if (onDisk.size === 0) return [...modIds];

        const modrinth: Array<{ raw: string; id: string }> = [];
        const thunderstore: Array<{ raw: string; id: string }> = [];
        const steam: string[] = [];
        const curseforge: Array<{ raw: string; id: string }> = [];
        for (const raw of modIds) {
            const parsed = parseModId(raw);
            if (parsed?.provider === 'modrinth') modrinth.push({ raw, id: parsed.id });
            else if (parsed?.provider === 'thunderstore') thunderstore.push({ raw, id: parsed.id });
            else if (parsed?.provider === 'steam') steam.push(raw);
            else if (parsed?.provider === 'curseforge') curseforge.push({ raw, id: parsed.id });
        }

        const missing: string[] = [];
        // A mod is present when any of its candidate file names is on disk.
        const present = (names: string[]): boolean => names.length === 0 || names.some((name) => onDisk.has(name));

        // Steam: a mod is present when its manifest-recorded .tmod is on disk.
        if (steam.length > 0) {
            const manifest = readSteamManifest(downloadPath);
            for (const raw of steam) {
                const fileName = manifest[raw];
                if (!fileName || !onDisk.has(fileName)) missing.push(raw);
            }
        }

        const modrinthLoader = modLoader ? modLoader.toLowerCase() : undefined;
        for (const m of modrinth) {
            const files = await modrinthAPI.getFilesForMod(m.id, gameVersion, modrinthLoader);
            if (!present(files.map((f) => f.fileName))) missing.push(m.raw);
        }
        if (thunderstore.length > 0) {
            const thunderstoreProvider = getModProvider('thunderstore');
            for (const t of thunderstore) {
                const files = await thunderstoreProvider.getFilesForMod(t.id);
                if (!present(files.map((f) => f.fileName))) missing.push(t.raw);
            }
        }
        for (const c of curseforge) {
            const files = await curseforgeAPI.getFilesForMod(c.id, gameVersion, modrinthLoader);
            if (!present(files.map((f) => f.fileName))) missing.push(c.raw);
        }
        return missing;
    } catch (error) {
        console.error('Error checking downloaded mods:', error);
        return [...modIds];
    }
}

async function removeModFiles(
    token: string,
    modIds: string[],
    downloadPath: string
): Promise<void> {
    if (!(await validateTokenForLocalOps(token)) || modIds.length === 0) return;
    if (!fs.existsSync(downloadPath)) return;

    for (const fileName of await resolveModFileNames(modIds, downloadPath)) {
        const filePath = path.join(downloadPath, fileName);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch {}
        }
    }
}

export { connectDB, disconnectDB, addUser, getUser, getAllUsers, validateUser, getAccountSettings, removeUser, validateWebToken, getAuthToken, setAuthToken, getRefreshToken, setRefreshToken, clearLogin, getUserDataFromToken, createModpack, getUsersModpacks, getModpackByNameForCurrentUser, updateModpack, deleteModpack, getAllModsForGame, getModsByIds, getNotifications, removeNotification, sendNotification, markNotificationsAsRead, handleAddContributerRequestAction, downloadMods, removeModFiles, resolveModFileNames, findMissingModIds };