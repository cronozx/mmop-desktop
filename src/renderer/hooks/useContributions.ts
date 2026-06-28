import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { NavigateFunction } from "react-router";
import { ContributionRequest, ModpackType, PublicUser } from "../../types/sharedTypes";
import type { AuthUser } from "../context/AuthContext";

interface UseContributionsParams {
    modpack: ModpackType | undefined;
    setModpack: Dispatch<SetStateAction<ModpackType>>;
    token: string | null;
    user: AuthUser | null;
    navigate: NavigateFunction;
    currentMods: string[];
    setCurrentMods: Dispatch<SetStateAction<string[]>>;
    /** Screen-level loading flag (cleared once the users fetch settles). */
    setLoading: Dispatch<SetStateAction<boolean>>;
    /** Downloads an explicit list of mods (from useModManagement). */
    downloadModList: (modsToDownload: string[]) => Promise<void>;
    /** Closes the "Add Mods" modal (from useModManagement). */
    closeModsModal: () => void;
}

/**
 * Owns contributor management (add/remove/pending invites), contribution
 * request parsing + accept/deny, the author/contributor save flows, and the
 * notifications that those flows send.
 */
export function useContributions({
    modpack,
    setModpack,
    token,
    user,
    navigate,
    currentMods,
    setCurrentMods,
    setLoading,
    downloadModList,
    closeModsModal,
}: UseContributionsParams) {
    const [registeredUsers, setRegisteredUsers] = useState<PublicUser[]>([]);
    const [contributersInModpack, setContributorsInModpack] = useState<PublicUser[]>([]);
    const [pendingContributers, setPendingContributers] = useState<PublicUser[]>([]);
    const [saving, setSaving] = useState<boolean>(false);
    const [saveError, setSaveError] = useState<string>('');
    const [addingContributorId, setAddingContributorId] = useState<string | null>(null);
    const [isContributor, setIsContributor] = useState(false);
    const [isAuthor, setIsAuthor] = useState(false);
    const [currentUserId, setCurrentUserId] = useState<string>('');
    const [contributionRequests, setContributionRequests] = useState<ContributionRequest[]>([]);
    const [hasChanges, setHasChanges] = useState<boolean>(false);
    // Feedback after a save: a contributor's request stays "submitted" (button
    // disabled + confirmation) and an author sees a saved confirmation, until
    // the working set changes again.
    const [submitted, setSubmitted] = useState<boolean>(false);
    const [saveSuccess, setSaveSuccess] = useState<string>('');
    // Snapshot of the mods at the last successful save, so we can tell when the
    // user has changed something worth saving/submitting again.
    const submittedSnapshotRef = useRef<string | null>(null);

    // Roles + the contributor/registered-user lists. Fetched once on mount and
    // NOT re-run on live refresh, so an author's in-progress contributor edits
    // (held in local state until they Save) are never reset underneath them.
    useEffect(() => {
        const fetchUsers = async () => {
            try {
                if (!token) {
                    navigate('/login');
                    return;
                }

                //Grabs users from db and sets useState
                const users = await window.db.getAllUsers(token);
                if (!users || !modpack?.contributers) {
                    return;
                }

                const currUser_Id = user?._id;

                if (!currUser_Id) {
                    throw new Error('Could not get current user id')
                }

                setCurrentUserId(currUser_Id);
                setIsAuthor(user?.username === modpack.author);
                setIsContributor(!!modpack.contributers[currUser_Id]);

                const confirmedContributers: PublicUser[] = users.filter(
                    user => modpack.contributers && modpack.contributers[user._id]
                );

                const pendingContributers: PublicUser[] = users.filter(
                    user => modpack.contributers && modpack.contributers[user._id] === false
                );

                setContributorsInModpack(confirmedContributers);
                setPendingContributers(pendingContributers);
                setRegisteredUsers(
                    users.filter(
                        user => user._id && !confirmedContributers.some(contrib => contrib._id === user._id) && !(user._id === currUser_Id)
                    )
                );
            } catch (error) {
                console.error('Error fetching users:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchUsers();
    }, [navigate])

    // Re-parse pending contribution requests whenever the modpack record
    // changes (including live refreshes), so an author sees newly submitted
    // requests and a contributor sees approvals/denials without leaving.
    useEffect(() => {
        if (!modpack?.proposedChanges) {
            setContributionRequests([]);
            return;
        }

        const parsed: ContributionRequest[] = [];
        Object.entries(modpack.proposedChanges).forEach(([key, value]) => {
            if (!value.proposedMods) {
                return;
            }

            const addedMods = value.proposedMods.filter((mod) => !modpack.mods.includes(mod));
            const removedMods = modpack.mods.filter((mod) => value.proposedMods && !value.proposedMods.includes(mod));

            parsed.push({
                addedMods,
                removedMods,
                timestamp: value.timestamp,
                status: value.status,
                contributerId: key,
            });
        });

        setContributionRequests(parsed);
    }, [modpack])

    useEffect(() => {
        const allContribIds = [...contributersInModpack, ...pendingContributers].map(u => u._id).filter(Boolean).sort();
        const modpackContribIds = Object.keys(modpack?.contributers || {}).sort();
        const changes = JSON.stringify(currentMods) !== JSON.stringify(modpack?.mods) || JSON.stringify(allContribIds) !== JSON.stringify(modpackContribIds);
        setHasChanges(changes);
    }, [currentMods, modpack, contributersInModpack, pendingContributers])

    // Clear the save/request confirmation once the working set diverges from
    // what was last saved (the user has new changes worth saving again).
    useEffect(() => {
        if (submittedSnapshotRef.current !== null && JSON.stringify(currentMods) !== submittedSnapshotRef.current) {
            submittedSnapshotRef.current = null;
            setSubmitted(false);
            setSaveSuccess('');
        }
    }, [currentMods])

    //User action handlers
    const handleAddUser = async (user: PublicUser) => {
        if (!token || !user._id || !modpack || !isAuthor || !!addingContributorId) {
            return;
        }

        const alreadyContributor = contributersInModpack.some(currUser => currUser._id === user._id);
        const alreadyPending = pendingContributers.some(currUser => currUser._id === user._id);
        if (alreadyContributor || alreadyPending) {
            return;
        }

        setAddingContributorId(user._id);
        setSaving(true);
        try {
            const updatedModpack: ModpackType = {
                ...modpack,
                contributers: {
                    ...(modpack.contributers || {}),
                    [user._id]: false,
                },
            };

            const success = await window.db.updateModpack(token, updatedModpack);
            if (!success) {
                return;
            }

            setModpack(updatedModpack);
            setRegisteredUsers(prev => prev.filter(regUser => regUser._id !== user._id));
            setPendingContributers(prev => [...prev, user]);

            await window.db.sendNotification(token, user._id, {
                id: await window.db.randUUID(),
                type: 'request',
                title: 'Contribution Request',
                message: `${modpack.author} invited you to contribute to "${modpack.name}"`,
                unread: true,
                modpack_Id: modpack._id,
            });
        } catch (error) {
            console.error('Error adding contributor:', error);
        } finally {
            setSaving(false);
            setAddingContributorId(null);
        }
    }

    const handleRemoveUser = (user: PublicUser) => {
        if (contributersInModpack.includes(user)) {
            setContributorsInModpack(contributersInModpack.filter(currUser => currUser._id !== user._id));
        } else if (pendingContributers.includes(user)) {
            setPendingContributers(pendingContributers.filter(currUser => currUser._id !== user._id));
        }

        setRegisteredUsers([...registeredUsers, user]);
    }

    // Whether a mod is still awaiting the author's approval. For a contributor,
    // anything not in the approved pack contents (modpack.mods) is unapproved —
    // whether it's a submitted proposal or a still-local addition. Authors own
    // the pack, so nothing is "pending" for them.
    const isModPendingApproval = (modId: string): boolean => {
        if (!isContributor || isAuthor) return false;
        return !(modpack?.mods.includes(modId) ?? false);
    };

    // Find the current contributor's pending request
    const myPendingRequest = (!isAuthor && isContributor && currentUserId)
        ? contributionRequests.find(req => req.contributerId === currentUserId && req.status === 'pending')
        : undefined;

    const handleDownloadMods = async (modsOverride?: string[]) => {
        // Contributors may only download the pack's approved contents, never
        // their own unsaved/pending-approval additions. Authors download their
        // current working set.
        const approvedMods = isAuthor ? currentMods : (modpack?.mods ?? []);
        const modsToDownload = modsOverride ?? approvedMods;
        if (modsToDownload.length === 0) return;
        await downloadModList(modsToDownload);
    };

    const updateModsAndContributionRequests = (request: ContributionRequest, status: "pending" | "approved" | "rejected", mods?: string[]) => {
        if (modpack?.proposedChanges) {
            if (mods !== undefined) {
                setCurrentMods(mods);
            }

            setContributionRequests(contributionRequests.filter(req => req !== request));

            if (status === 'approved' || status === 'rejected') {
                delete modpack.proposedChanges[request.contributerId];
            } else if (modpack.proposedChanges[request.contributerId]) {
                modpack.proposedChanges[request.contributerId].status = status;
            }
        }
    };

    const filterModsAfterContribution = (request: ContributionRequest): string[] => {
        const newMods = [...new Set([...request.addedMods, ...currentMods])];
        return newMods.filter(modId => !request.removedMods.includes(modId))
    }

    //Contribution action handlers
    const handleContributionAction = async (action: 'accept' | 'deny', contributionRequest: ContributionRequest) => {
        if (!token || !modpack) {
            return;
        }

        if (action === 'accept') {
            const newMods = filterModsAfterContribution(contributionRequest);
            updateModsAndContributionRequests(contributionRequest, "approved", newMods);
            // handleSave downloads the saved mod list itself on success.
            const saved = await handleSave(newMods);
            if (!saved) {
                return;
            }

            await window.db.sendNotification(token, contributionRequest.contributerId, {
                id: await window.db.randUUID(),
                type: 'alert',
                title: 'Contribution Accepted',
                message: `Your changes to "${modpack.name}" were accepted.`,
                unread: true,
                modpack_Id: modpack._id
            });
        } else if (action === 'deny') {
            updateModsAndContributionRequests(contributionRequest, "rejected");
            const saved = await handleSave();
            if (!saved) {
                return;
            }

            await window.db.sendNotification(token, contributionRequest.contributerId, {
                id: await window.db.randUUID(),
                type: 'alert',
                title: 'Contribution Declined',
                message: `Your changes to "${modpack.name}" were declined.`,
                unread: true,
                modpack_Id: modpack._id
            });
        }
    };

    const handleSave = async (modsOverride?: string[]): Promise<boolean> => {
        if (!modpack) return false;

        // Guard against non-array values (e.g. a click event when the handler
        // is wired directly to onClick) being treated as a mods override.
        const override = Array.isArray(modsOverride) ? modsOverride : undefined;

        setSaving(true);
        setSaveError('');

        if (!token) {
            setSaving(false);
            navigate('/login');
            return false;
        }

        try {
            if (isAuthor) {
                const modsToSave = override ?? currentMods;
                const allContributers = [...contributersInModpack, ...pendingContributers];
                const contributersPairs: { [userId: string]: boolean } = {};
                allContributers.forEach(user => {
                    if (user._id) {
                        if (contributersInModpack.includes(user)) {
                            contributersPairs[user._id] = true;
                        } else {
                            contributersPairs[user._id] = false;
                        }
                    }
                });

                const updatedModpack: ModpackType = {
                    ...modpack,
                    contributers: contributersPairs,
                    mods: modsToSave
                };

                const newPendingInvitees = pendingContributers.filter(user => {
                    if (!user._id) {
                        return false;
                    }
                    return !(user._id in (modpack.contributers || {}));
                });

                const success = await window.db.updateModpack(token, updatedModpack);

                if (success) {
                    console.log('Modpack updated successfully');

                    // Delete files for mods that were removed
                    const removedModIds = modpack.mods.filter(id => !modsToSave.includes(id));
                    if (removedModIds.length > 0) {
                        window.db.removeModFiles(token, removedModIds, modpack.name, modpack.gameID);
                    }

                    setModpack(updatedModpack);
                    setHasChanges(false);
                    submittedSnapshotRef.current = JSON.stringify(modsToSave);
                    setSaveSuccess('Your changes were saved.');

                    // Author saves always fetch the saved mod list so newly added
                    // or missing mods land on disk (files already present are
                    // skipped cheaply by the main process). Fire-and-forget so
                    // the save flow (and modal close) is not blocked.
                    void handleDownloadMods(modsToSave);

                    newPendingInvitees.forEach(async (user) => {
                        if (!user._id) {
                            return;
                        }

                        window.db.sendNotification(token, user._id, {
                            id: await window.db.randUUID(),
                            type: 'request',
                            title: 'Contribution Request',
                            message: `${modpack.author} invited you to contribute to "${modpack?.name}"`,
                            unread: true,
                            modpack_Id: modpack._id
                        })
                    });

                    closeModsModal();
                    return true;
                } else {
                    console.error('Failed to update modpack');
                    setSaveError('Failed to save changes. Please try again.');
                    return false;
                }
            } else if (isContributor) {
                if (!user) {
                    setSaveError('Failed to save changes. Please try again.');
                    return false;
                }

                // Older modpacks may not have a proposedChanges map yet.
                const updatedModpack: ModpackType = {
                    ...modpack,
                    proposedChanges: {
                        ...(modpack.proposedChanges ?? {}),
                        [user._id]: {
                            proposedMods: currentMods,
                            timestamp: new Date(),
                            status: 'pending',
                        },
                    },
                };

                const success = await window.db.updateModpack(token, updatedModpack);

                if (success) {
                    console.log('Modpack updated successfully');
                    setModpack(updatedModpack);
                    setHasChanges(false);
                    submittedSnapshotRef.current = JSON.stringify(currentMods);
                    setSubmitted(true);
                    setSaveSuccess('Your request was submitted — the author will review your changes.');

                    pendingContributers.forEach(async (user) => {
                        if (!user._id) {
                            return;
                        }

                        window.db.sendNotification(token, user._id, {
                            id: await window.db.randUUID(),
                            type: 'alert',
                            title: 'Approve Changes',
                            message: `${user.username} would like you to approve changes to "${modpack?.name}"`,
                            unread: true,
                            modpack_Id: modpack._id
                        })
                    });

                    closeModsModal();
                    return true;
                } else {
                    console.error('Failed to update modpack');
                    setSaveError('Failed to submit your changes. Please try again.');
                    return false;
                }
            }
        } catch (error) {
            console.error('Error saving modpack:', error);
            setSaveError('Failed to save changes. Please try again.');
            return false;
        } finally {
            setSaving(false);
        }

        setSaveError('Only the author or contributors can save changes.');
        return false;
    };

    return {
        registeredUsers,
        contributersInModpack,
        pendingContributers,
        saving,
        saveError,
        clearSaveError: () => setSaveError(''),
        submitted,
        saveSuccess,
        clearSaveSuccess: () => setSaveSuccess(''),
        addingContributorId,
        isAuthor,
        isContributor,
        contributionRequests,
        hasChanges,
        myPendingRequest,
        isModPendingApproval,
        handleAddUser,
        handleRemoveUser,
        handleContributionAction,
        handleSave,
        handleDownloadMods,
    };
}
