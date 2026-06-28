import React from "react";
import { FiCheck, FiCircle } from "react-icons/fi";
import { PASSWORD_RULES } from "../../config/password";

interface PasswordRequirementsProps {
    /** The password being typed; each rule lights up as it's satisfied. */
    password: string;
    className?: string;
}

/** Live checklist of the shared password policy. */
const PasswordRequirements: React.FC<PasswordRequirementsProps> = ({ password, className }) => (
    <ul className={`grid grid-cols-1 gap-1 sm:grid-cols-2 ${className ?? ''}`} aria-label="Password requirements">
        {PASSWORD_RULES.map((rule) => {
            const met = rule.test(password);
            return (
                <li key={rule.id} className={`flex items-center gap-1.5 text-xs ${met ? 'text-emerald-300' : 'text-slate-500'}`}>
                    {met ? <FiCheck size={12} /> : <FiCircle size={10} />}
                    <span>{rule.label}</span>
                </li>
            );
        })}
    </ul>
);

export default PasswordRequirements;
