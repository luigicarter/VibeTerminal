import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './workspaceToolsDialog.css';

export function WorkspaceToolsDialog({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="workspace-tools-dialog" aria-labelledby="workspace-tools-title" onCancel={onClose}>
    <header className="workspace-tools-heading"><h2 id="workspace-tools-title">Workspace tools</h2><button aria-label="Close workspace tools" onClick={onClose}><X size={18}/></button></header>
    {children}
  </dialog>;
}
