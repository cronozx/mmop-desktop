import React from "react";
import { FiTrash2 } from "react-icons/fi";
import Modal from "../Modal";

interface DeleteConfirmModalProps {
    modpackName: string;
    deleting: boolean;
    onConfirm: () => void;
    onClose: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
    modpackName, deleting, onConfirm, onClose,
}) => {
    return (
        <Modal
            onClose={onClose}
            title="Delete Modpack"
            busy={deleting}
            panelClassName="max-w-md border-rose-500/25 bg-[#161b22]/92"
        >
            <div className="p-6 pt-4">
                <p className="mb-2 text-sm text-slate-300">
                    Are you sure you want to delete <span className="text-white font-semibold">{modpackName}</span>?
                </p>
                <p className="mb-8 text-xs text-slate-500">This action cannot be undone.</p>
                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        disabled={deleting}
                        className="clean-button clean-button-ghost flex-1 px-4 py-3 disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={deleting}
                        className="clean-button clean-button-danger flex-1 px-4 py-3 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <FiTrash2 size={16} />
                        <span>{deleting ? 'Deleting...' : 'Delete'}</span>
                    </button>
                </div>
            </div>
        </Modal>
    );
};

export default DeleteConfirmModal;
