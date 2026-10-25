import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import Quill from 'quill';
import { QuillBinding } from 'y-quill';
import 'quill/dist/quill.snow.css';

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function CollaborativeEditor({ documentId, initialRevision, onRevision, onCreditUpdate, onProblem }: { documentId: string; initialRevision: number; onRevision: (revision: number) => void; onCreditUpdate: () => void; onProblem: (message: string) => void }) {
  const [charCount, setCharCount] = useState(0);
  const [status, setStatus] = useState('Connexion au document…');
  const [participants, setParticipants] = useState<string[]>([]);
  const [synced, setSynced] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const callbacks = useRef({ onRevision, onCreditUpdate, onProblem });
  callbacks.current = { onRevision, onCreditUpdate, onProblem };
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(initialRevision);
  useEffect(() => { setRevision(initialRevision); }, [documentId, initialRevision]);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const quill = new Quill(editorRef.current!, {
      theme: 'snow', readOnly: true, placeholder: 'Commencez à écrire ici…',
      modules: { toolbar: [[{ header: [1, 2, false] }], ['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['blockquote', 'link']] },
    });
    const binding = new QuillBinding(ytext, quill);
    const updateCharacterCount = () => setCharCount(Array.from(ytext.toString()).length);
    ytext.observe(updateCharacterCount);
    const apiUrl = new URL(import.meta.env.VITE_API_URL ?? 'http://localhost:3000');
    apiUrl.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    apiUrl.pathname = `/ws/documents/${documentId}`;
    apiUrl.search = '';
    const socket = new WebSocket(apiUrl);
    let synchronized = false;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingUpdate: Uint8Array | undefined;
    const flushUpdate = () => {
      if (!pendingUpdate || !synchronized || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'update', operationId: crypto.randomUUID(), update: bytesToBase64(pendingUpdate) }));
      pendingUpdate = undefined;
    };

    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      pendingUpdate = pendingUpdate ? Y.mergeUpdates([pendingUpdate, update]) : update;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flushUpdate, 250);
    });
    socket.onopen = () => setStatus('Connexion établie · synchronisation…');
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type: string; update?: string; users?: string[]; revision?: number; message?: string };
        if (message.type === 'sync' && message.update) {
          Y.applyUpdate(ydoc, Uint8Array.from(atob(message.update), (char) => char.charCodeAt(0)), 'remote');
          synchronized = true; flushUpdate(); quill.enable(true); setSynced(true); setStatus('Modifications synchronisées');
        } else if (message.type === 'update' && message.update) {
          Y.applyUpdate(ydoc, Uint8Array.from(atob(message.update), (char) => char.charCodeAt(0)), 'remote');
          if (message.revision) { setRevision(message.revision); callbacks.current.onRevision(message.revision); }
        } else if (message.type === 'presence') setParticipants(message.users ?? []);
        else if (message.type === 'accepted' && message.revision) {
          setRevision(message.revision); callbacks.current.onRevision(message.revision);
          setStatus(`Enregistré · version ${message.revision}`); callbacks.current.onCreditUpdate();
        } else if (message.type === 'error') {
          setStatus(message.message ?? 'Modification refusée. Rechargement du document…');
          callbacks.current.onProblem(message.message ?? 'Modification refusée.');
          synchronized = false; setSynced(false); socket.close(); setReconnect((value) => value + 1);
        }
      } catch { setStatus('Réponse invalide du service collaboratif.'); }
    };
    socket.onerror = () => setStatus('Connexion au service collaboratif impossible.');
    socket.onclose = () => {
      if (!closed) {
        synchronized = false; setSynced(false); quill.enable(false); setStatus('Connexion interrompue · reconnexion…');
        reconnectTimer = setTimeout(() => setReconnect((value) => value + 1), 2000);
      }
    };
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) clearTimeout(flushTimer);
      flushUpdate();
      ytext.unobserve(updateCharacterCount); binding.destroy(); socket.close(); quill.disable(); ydoc.destroy();
      const toolbar = quill.getModule('toolbar') as { container?: HTMLElement } | undefined;
      toolbar?.container?.remove();
      editorRef.current?.replaceChildren();
      editorRef.current?.classList.remove('ql-container', 'ql-snow', 'ql-disabled');
    };
  }, [documentId, reconnect]);

  return <div className="editor-card"><div ref={editorRef} aria-label="Éditeur collaboratif" />{!synced && <div className="editor-overlay">{status}</div>}<div className="editor-footer"><span>{charCount.toLocaleString('fr-FR')} caractères · version {revision}</span><span>{status}{participants.length > 0 ? ` · ${participants.length} rédacteur(s) connecté(s)` : ''}</span></div></div>;
}

