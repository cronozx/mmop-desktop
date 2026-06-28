import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    sendNotification,
    getNotifications,
    markNotificationsAsRead,
    handleAddContributerRequestAction,
    removeNotification,
} from '../database/database.js';
import { callBackendWithAuth, getBackendApiBaseUrl } from '../backend-client.js';
import type { NotifiactionType } from '../../types/sharedTypes.js';

/** Notification IPC: send, list, mark read, remove, contributor-request actions. */

export function registerNotificationHandlers(): void {
    ipcMain.handle('sendNotification', async (_e: IpcMainInvokeEvent, token: string, _id: string, notification: NotifiactionType) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'POST',
                    path: '/notifications/send',
                    token,
                    data: { targetUserId: _id, notification },
                });

                return !!response && response.status === 200 && !!response.data?.success;
            } catch {
                return false;
            }
        }

        return await sendNotification(token, _id, notification);
    });

    ipcMain.handle('getNotifications', async (_e: IpcMainInvokeEvent, token: string, _id: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                const response = await callBackendWithAuth({
                    method: 'GET',
                    path: `/notifications/${encodeURIComponent(_id)}`,
                    token,
                });

                if (!response || response.status !== 200 || !Array.isArray(response.data?.notifications)) {
                    return [];
                }

                return response.data.notifications;
            } catch {
                return [];
            }
        }

        return await getNotifications(token, _id);
    });

    ipcMain.handle('removeNotification', async (_e: IpcMainInvokeEvent, token: string, notificationId) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                await callBackendWithAuth({
                    method: 'DELETE',
                    path: `/notifications/${encodeURIComponent(String(notificationId))}`,
                    token,
                });
            } catch {
                // Ignore remove failures to keep UI non-blocking.
            }
            return;
        }

        return await removeNotification(token, notificationId);
    });

    ipcMain.handle('markNotificationsAsRead', async (_e: IpcMainInvokeEvent, token: string) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                await callBackendWithAuth({
                    method: 'POST',
                    path: '/notifications/mark-read',
                    token,
                    data: {},
                });
            } catch {
                // Ignore mark-read failures to keep UI non-blocking.
            }
            return;
        }

        return await markNotificationsAsRead(token);
    });

    ipcMain.handle('handleAddContributerRequestAction', async (_e: IpcMainInvokeEvent, token: string, modpack_Id: string, accepted: boolean) => {
        const backendBaseUrl = getBackendApiBaseUrl();
        if (backendBaseUrl) {
            try {
                await callBackendWithAuth({
                    method: 'POST',
                    path: `/modpacks/${encodeURIComponent(modpack_Id)}/contributor-action`,
                    token,
                    data: { accepted },
                });
            } catch {
                // Ignore request-action failures to avoid crashing notification flow.
            }
            return;
        }

        return await handleAddContributerRequestAction(token, modpack_Id, accepted);
    });
}
