import React from "react";
import { FiPlus, FiUser, FiX } from "react-icons/fi";
import { PublicUser } from "../../../types/sharedTypes";
import Modal from "../Modal";

interface AddContributorsModalProps {
    searchQuery: string;
    onSearchChange: (value: string) => void;
    filteredUsers: PublicUser[];
    onAddUser: (user: PublicUser) => Promise<void>;
    addingContributorId: string | null;
    onClose: () => void;
}

const AddContributorsModal: React.FC<AddContributorsModalProps> = ({
    searchQuery, onSearchChange, filteredUsers, onAddUser, addingContributorId, onClose,
}) => {
    return (
        <Modal
            onClose={onClose}
            label="Add contributors"
            hideHeader
            panelClassName="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden border-[#232a34]/45 bg-[#161b22]/92"
        >
                    <div className="flex items-center justify-between border-b border-[#232a34]/45 p-6">
                        <h3 className="text-2xl font-bold text-white">Add Contributors to Pack</h3>
                        <button
                            onClick={onClose}
                            className="clean-button clean-button-ghost p-2 text-slate-400 hover:text-white"
                            aria-label="Close dialog"
                        >
                            <FiX size={24} />
                        </button>
                    </div>

                    <div className="border-b border-[#232a34]/45 p-6">
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => onSearchChange(e.target.value)}
                            placeholder="Search people..."
                            className="clean-input"
                        />
                    </div>

                    <div className="clean-scroll flex-1 overflow-y-auto p-6">
                        {filteredUsers.length === 0 ? (
                            <div className="text-center py-12">
                                <p className="text-slate-400">
                                    {searchQuery ? 'No users match your search' : 'Start searching for users'}
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {filteredUsers.map((user) => (
                                    (() => {
                                        const isAddingThisUser = addingContributorId === user._id;
                                        const isAnyAddPending = !!addingContributorId;
                                        return (
                                    <div
                                        key={user._id}
                                        className="clean-panel-muted group rounded-lg p-4 transition-all duration-200 hover:border-slate-400/40"
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center space-x-2 text-white">
                                                    <FiUser className="text-s" />
                                                    <h4 className="text-white font-semibold">{user.username}</h4>
                                                </div>
                                            </div>
                                            <button
                                                onClick={async () => user && await onAddUser(user)}
                                                disabled={isAnyAddPending}
                                                className="clean-button clean-button-primary px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                                                type="button"
                                            >
                                                {isAddingThisUser ? (
                                                    <span>Adding...</span>
                                                ) : (
                                                    <>
                                                        <FiPlus size={16} />
                                                        <span>Add</span>
                                                    </>
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                        );
                                    })()
                                ))}
                            </div>
                        )}
                    </div>
        </Modal>
    );
};

export default AddContributorsModal;
