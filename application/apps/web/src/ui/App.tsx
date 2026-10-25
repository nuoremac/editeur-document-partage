import { FormEvent, lazy, Suspense, useEffect, useState } from 'react';
import { api, AdminOverview, Credit, Document, DocumentSummary, Link, Person, ServerNotification, Version } from './api';

const CollaborativeEditor = lazy(() => import('./CollaborativeEditor').then((module) => ({ default: module.CollaborativeEditor })));

const PERSON_KEY = 'journal.person';
type NotificationItem = { id: string; title: string; message: string; createdAt: string; kind: 'success' | 'error' | 'system'; read: boolean };

function readNotifications(key: string): NotificationItem[] {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') as NotificationItem[]; }
  catch { return []; }
}

function useNotifications(personId?: string) {
  const key = `atelier.notifications.${personId ?? 'guest'}`;
  const [items, setItems] = useState<NotificationItem[]>(() => readNotifications(key));
  useEffect(() => { setItems(readNotifications(key)); }, [key]);
  useEffect(() => {
    if (!personId) return;
    let active = true;
    const sync = async () => {
      try {
        const result = await api.notifications();
        if (!active) return;
        setItems((current) => {
          const known = new Map(current.map((item) => [item.id, item]));
          const remote = result.notifications.map((item: ServerNotification): NotificationItem => ({
            id: `system:${item.id}`, title: item.title, message: item.message,
            createdAt: item.created_at, kind: 'system', read: known.get(`system:${item.id}`)?.read ?? false,
          }));
          const remoteIds = new Set(remote.map((item) => item.id));
          const merged = [...remote, ...current.filter((item) => !item.id.startsWith('system:') || remoteIds.has(item.id))]
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100);
          localStorage.setItem(key, JSON.stringify(merged));
          return merged;
        });
      } catch { /* Les notifications locales restent disponibles si l’API est hors ligne. */ }
    };
    void sync();
    const timer = window.setInterval(sync, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [key, personId]);
  function add(kind: NotificationItem['kind'], message: string) {
    if (!message) return;
    const item: NotificationItem = { id: crypto.randomUUID(), title: kind === 'error' ? 'Erreur' : 'Information', message, createdAt: new Date().toISOString(), kind, read: false };
    setItems((current) => { const next = [item, ...current].slice(0, 100); localStorage.setItem(key, JSON.stringify(next)); return next; });
  }
  function markRead(id: string) {
    setItems((current) => { const next = current.map((item) => item.id === id ? { ...item, read: true } : item); localStorage.setItem(key, JSON.stringify(next)); return next; });
  }
  function markAllRead() {
    setItems((current) => { const next = current.map((item) => ({ ...item, read: true })); localStorage.setItem(key, JSON.stringify(next)); return next; });
  }
  return { items, add, markRead, markAllRead };
}

function NotificationButton({ items, onRead, onReadAll }: { items: NotificationItem[]; onRead: (id: string) => void; onReadAll: () => void }) {
  const [open, setOpen] = useState(false);
  const unread = items.filter((item) => !item.read).length;
  return <div className="notification-menu">
    <button className="notification-trigger" type="button" aria-label="Ouvrir les notifications" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
      {unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <section className="notification-panel" aria-label="Centre de notifications">
      <header><strong>Notifications</strong><button type="button" onClick={onReadAll} disabled={unread === 0}>Tout marquer comme lu</button></header>
      {items.length === 0 ? <p className="notification-empty">Aucune notification pour le moment.</p> : <div className="notification-list">{items.map((item) => <button type="button" className={`notification-item ${item.read ? 'is-read' : 'is-unread'} ${item.kind}`} key={item.id} onClick={() => onRead(item.id)}>
        <span className="notification-dot"/><span className="notification-copy"><strong>{item.title}</strong><span>{item.message}</span><small>{new Date(item.createdAt).toLocaleString('fr-FR')}</small></span>
      </button>)}</div>}
    </section>}
  </div>;
}


export function App() {
  const token = window.location.pathname.match(/^\/share\/([^/]+)\/?$/)?.[1];
  return token ? <PublicDownload token={token} /> : <Workspace />;
}

function Workspace() {
  const [person, setPerson] = useState<Person | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [opened, setOpened] = useState<Document | null>(null);
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const notifications = useNotifications(person?.id);

  function announce(message: string) { setNotice(message); notifications.add('success', message); }
  function reportProblem(message: string) { setProblem(message); if (message) notifications.add('error', message); }

  async function refresh(current = person) {
    if (!current) return;
    const [documentData, linkData, creditData] = await Promise.all([api.documents(current), api.links(current), api.credit(current)]);
    setDocuments(documentData.documents);
    setLinks(linkData.links);
    setCredit(creditData);
  }
  useEffect(() => {
    api.me().then((user) => { setPerson(user); localStorage.setItem(PERSON_KEY, JSON.stringify(user)); })
      .catch(() => { setPerson(null); localStorage.removeItem(PERSON_KEY); });
  }, []);
  useEffect(() => { if (person) refresh().catch((error: Error) => reportProblem(error.message)); }, [person?.id]);

  async function identify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setProblem(''); setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const user = data.get('mode') === 'register'
        ? await api.register(String(data.get('name')), String(data.get('email')), String(data.get('password')))
        : await api.login(String(data.get('email')), String(data.get('password')));
      localStorage.setItem(PERSON_KEY, JSON.stringify(user)); setPerson(user);
    } catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  }

  async function createDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!person) return;
    const form = event.currentTarget;
    const data = new FormData(form); setProblem('');
    try {
      const doc = await api.createDocument(person, String(data.get('title')));
      announce('Document créé.'); form.reset(); await refresh(); await openDocument(doc.id);
    } catch (error) { reportProblem((error as Error).message); }
  }

  async function openDocument(id: string) {
    if (!person) return;
    setProblem('');
    try { setOpened(await api.document(person, id)); }
    catch (error) { reportProblem((error as Error).message); }
  }

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!person || !opened) return;
    const data = new FormData(event.currentTarget);
    try {
      const result = await api.createLink(person, opened.id, Number(data.get('limit')));
      await navigator.clipboard.writeText(result.url).catch(() => undefined);
      announce(`Lien créé et copié : ${result.url}`); await refresh();
    } catch (error) { reportProblem((error as Error).message); }
  }

  if (!person) return <AuthPanel onSubmit={identify} busy={busy} problem={problem} />;
  if (window.location.pathname === '/admin') return person.role === 'ADMIN'
    ? <AdminDashboard person={person} onLogout={async () => { await api.logout(); localStorage.removeItem(PERSON_KEY); setPerson(null); }} />
    : <main className="entry-screen"><section className="entry-card"><h1>Accès réservé</h1><p className="muted">Ce compte ne dispose pas du rôle administrateur.</p><a href="/">Retour à mon espace</a></section></main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark small brand-image" src="/Feather.jpeg" alt="Logo Atelier" /><span>atelier<span className="brand-dot">.</span></span></div>
      <div className="workspace-label">ESPACE ÉDITORIAL</div>
      <button className={`nav-item ${!opened ? 'selected' : ''}`} onClick={() => setOpened(null)}><span>▦</span> Mes documents</button>
      {person.role === 'ADMIN' && <a className="nav-item" href="/admin"><span>⚙</span> Administration</a>}
      <div className="sidebar-bottom"><div className="avatar">{person.name.slice(0, 1).toUpperCase()}</div><div className="user-info"><strong>{person.name}</strong><span>Rédacteur</span></div><button className="quiet logout-button" type="button" title="Se déconnecter" aria-label="Se déconnecter" onClick={async () => { await api.logout(); localStorage.removeItem(PERSON_KEY); setPerson(null); setOpened(null); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4h7v16h-7"/><path d="M3 12h11m-4-4 4 4-4 4"/></svg></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div><span className="muted">Journal étudiant</span><span className="slash">/</span><strong>{opened?.title ?? 'Vue d’ensemble'}</strong></div><div className="topbar-actions"><NotificationButton items={notifications.items} onRead={notifications.markRead} onReadAll={notifications.markAllRead} /><div className="top-user">{person.name} <span className="avatar tiny">{person.name.slice(0, 1).toUpperCase()}</span></div></div></header>
      <div className={`content-area ${opened ? 'content-area-document' : ''}`}>
        {problem && <div className="alert error">{problem}<button className="quiet" onClick={() => setProblem('')}>×</button></div>}
        {notice && <div className="alert success">{notice}<button className="quiet" onClick={() => setNotice('')}>×</button></div>}
        {opened ? <DocumentView document={opened} person={person} busy={busy} onBack={() => setOpened(null)} onCreateLink={createLink} onNotice={announce} onProblem={reportProblem} onRevision={(revision) => setOpened((current) => current ? { ...current, revision } : current)} onCreditUpdate={refresh} onRestored={(doc) => { setOpened(doc); announce('Version restaurée.'); refresh(); }} /> : <>
          <div className="page-heading"><div><p className="eyebrow">VOTRE ESPACE</p><h1>Bonjour, {person.name.split(' ')[0]}.</h1><p className="muted">Reprenez votre travail ou démarrez un nouveau texte.</p></div><div className="credit-card"><span>CRÉDIT D’ÉCRITURE AUJOURD’HUI</span><strong>{credit?.remaining.toLocaleString('fr-FR') ?? '—'} <small>caractères</small></strong><div className="meter"><i style={{ width: `${credit ? Math.max(0, Math.min(100, credit.used / credit.limit * 100)) : 0}%` }} /></div><small>{credit?.used.toLocaleString('fr-FR') ?? '—'} utilisés sur {credit?.limit.toLocaleString('fr-FR') ?? '10 000'}</small></div></div>
          <section className="section-head"><div><h2>Vos documents <span className="count">{documents.length}</span></h2><p className="muted">Textes auxquels vous avez accès.</p></div><form className="new-document" onSubmit={createDocument}><input name="title" required maxLength={200} placeholder="Titre du nouveau document" /><button className="primary">Créer <span>+</span></button></form></section>
          {documents.length ? <div className="document-grid">{documents.map((doc) => <button className="document-card" key={doc.id} onClick={() => openDocument(doc.id)}><div className="doc-icon">▤</div><span className="role-pill">{doc.role === 'OWNER' ? 'Propriétaire' : 'Partagé'}</span><h3>{doc.title}</h3><p>Version {doc.revision} · modifié {new Date(doc.updated_at).toLocaleDateString('fr-FR')}</p><span className="open-label">Ouvrir le document <b>→</b></span></button>)}</div> : <div className="empty-state"><div className="empty-icon">▤</div><h3>Votre espace commence ici</h3><p>Créez un document et invitez les autres rédacteurs.</p></div>}
          {links.length > 0 && <section className="links-section"><h2>Liens de téléchargement</h2><div className="link-list">{links.map((link) => <div className="link-row" key={link.token}><span className="link-indicator" /><div><strong>{link.title}</strong><small>{link.state === 'ACTIVE' ? `${link.remaining} téléchargement(s) restant(s)` : 'Quota épuisé'}</small></div><button className="secondary" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/share/${link.token}`).then(() => announce('Lien copié.')).catch(() => announce(`${window.location.origin}/share/${link.token}`))}>Copier le lien</button></div>)}</div></section>}
        </>}
      </div>
    </main>
  </div>;

}

function AuthPanel({ onSubmit, busy, problem }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; problem: string }) {
  const [register, setRegister] = useState(false);
  return <main className="entry-screen"><section className="entry-card">
    <img className="brand-mark brand-image" src="/Feather.jpeg" alt="Logo Atelier" /><p className="eyebrow">ATELIER ÉDITORIAL</p><h1>{register ? 'Créer votre compte.' : 'Bienvenue dans votre espace.'}</h1>
    <p className="muted">{register ? 'Créez un compte pour rédiger et partager vos documents.' : 'Connectez-vous pour retrouver vos documents.'}</p>
    <form className="stack" onSubmit={onSubmit}>
      <input type="hidden" name="mode" value={register ? 'register' : 'login'} />
      {register && <label>Votre nom<input name="name" autoComplete="name" required maxLength={100} placeholder="Ex. Amina Nguema" /></label>}
      <label>Adresse e-mail<input name="email" type="email" autoComplete="email" required placeholder="amina@exemple.com" /></label>
      <label>Mot de passe<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 10 : 1} required /></label>
      <button className="primary" disabled={busy}>{busy ? 'Veuillez patienter…' : register ? 'Créer mon compte' : 'Se connecter'} <span>→</span></button>
    </form>
    {problem && <p className="error">{problem}</p>}
    <button className="quiet" onClick={() => setRegister(!register)}>{register ? 'J’ai déjà un compte' : 'Créer un compte'}</button>
  </section></main>;
}

function AdminDashboard({ person, onLogout }: { person: Person; onLogout: () => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const notifications = useNotifications(person.id);
  function announce(message: string) { setNotice(message); notifications.add('success', message); }
  function reportProblem(message: string) { setError(message); if (message) notifications.add('error', message); }
  async function refresh() { try { setOverview(await api.adminOverview()); } catch (e) { reportProblem((e as Error).message); } }
  useEffect(() => { refresh(); }, []);
  async function toggleBlock(user: AdminOverview['people'][number]) {
    try {
      if (user.blocked) await api.unblockPerson(user.id);
      else {
        const reason = window.prompt(`Motif du blocage de ${user.name} ?`);
        if (!reason) return;
        await api.blockPerson(user.id, reason, 24);
      }
      announce(user.blocked ? 'Compte débloqué.' : 'Compte bloqué pendant 24 heures.');
      await refresh();
    } catch (e) { reportProblem((e as Error).message); }
  }
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><img className="brand-mark small brand-image" src="/Feather.jpeg" alt="Logo Atelier" /><span>atelier<span className="brand-dot">.</span></span></div><div className="workspace-label">ADMINISTRATION</div><a className="nav-item" href="/">← Espace rédacteur</a><div className="sidebar-bottom"><div className="avatar">{person.name[0].toUpperCase()}</div><div className="user-info"><strong>{person.name}</strong><span>Administrateur</span></div><button className="quiet logout-button" type="button" title="Se déconnecter" aria-label="Se déconnecter" onClick={onLogout}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4h7v16h-7"/><path d="M3 12h11m-4-4 4 4-4 4"/></svg></button></div></aside>
    <main className="main-area"><header className="topbar"><strong>Tableau de bord administrateur</strong><div className="topbar-actions"><NotificationButton items={notifications.items} onRead={notifications.markRead} onReadAll={notifications.markAllRead} /><a href="/">Retour à l’application</a></div></header><div className="content-area"><p className="eyebrow">SUPERVISION</p><h1>Vue d’ensemble</h1>{error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}
      <div className="document-grid">{Object.entries({ Comptes: overview?.metrics.accounts, Documents: overview?.metrics.documents, 'Liens publiés': overview?.metrics.links, Téléchargements: overview?.metrics.reservations, 'PDF en attente': overview?.metrics.pending_pdfs, 'E-mails en attente': overview?.metrics.pending_notifications }).map(([label, value]) => <article className="document-card" key={label}><span className="eyebrow">{label.toUpperCase()}</span><h2>{value ?? '—'}</h2></article>)}</div>
      <section className="links-section"><h2>Comptes récents</h2><div className="link-list">{overview?.people.map((user) => <div className="link-row" key={user.id}><div><strong>{user.name} {user.role === 'ADMIN' && '· Administrateur'}</strong><small>{user.email} · créé le {new Date(user.created_at).toLocaleDateString('fr-FR')} {user.blocked ? '· Suspendu' : ''}</small></div>{user.id !== person.id && <button className="secondary" onClick={() => toggleBlock(user)}>{user.blocked ? 'Débloquer' : 'Suspendre 24 h'}</button>}</div>)}</div></section>
      <section className="links-section"><h2>Dernières demandes de PDF</h2><div className="link-list">{overview?.recentReservations.map((job) => <div className="link-row" key={job.id}><div><strong>{job.title}</strong><small>Version {job.revision} · {new Date(job.created_at).toLocaleString('fr-FR')}</small></div><span className="role-pill">{job.state}</span></div>)}</div></section>
    </div></main></div>;
}

function DocumentView({ document, person, busy, onBack, onCreateLink, onNotice, onProblem, onRevision, onCreditUpdate, onRestored }: { document: Document; person: Person; busy: boolean; onBack: () => void; onCreateLink: (event: FormEvent<HTMLFormElement>) => void; onNotice: (message: string) => void; onProblem: (message: string) => void; onRevision: (revision: number) => void; onCreditUpdate: () => void; onRestored: (document: Document) => void }) {
  const [limit, setLimit] = useState('500');
  const [versions, setVersions] = useState<Version[]>([]);
  const [shareEmail, setShareEmail] = useState('');
  useEffect(() => { api.versions(person, document.id).then((data) => setVersions(data.versions)).catch((e: Error) => onProblem(e.message)); }, [person.id, document.id, document.revision]);
  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { await api.share(person, document.id, shareEmail); setShareEmail(''); onNotice('Accès accordé au rédacteur.'); }
    catch (e) { onProblem((e as Error).message); }
  }
  async function restore(version: Version) {
    if (!window.confirm(`Restaurer la version ${version.revision} ? Le contenu actuel sera conservé dans l’historique.`)) return;
    try { onRestored({ ...await api.restore(person, document.id, version.id), role: document.role }); }
    catch (e) { onProblem((e as Error).message); }
  }
  async function createSnapshot() {
    try {
      const version = await api.createVersion(person, document.id);
      setVersions((current) => [version, ...current.filter((item) => item.revision !== version.revision)]);
      onNotice(`Point de restauration créé à la version ${version.revision}.`);
    } catch (e) { onProblem((e as Error).message); }
  }
  return <div className="document-layout">
    <aside className="document-aside" aria-label="Outils du document">
      <button className="back-link" onClick={onBack}>← Tous les documents</button>
      <section className="document-tool-section">
        <div className="document-tool-heading"><h2>Historique</h2><span>{versions.length}</span></div>
        <button className="snapshot-button" onClick={createSnapshot}>＋ Créer un point de restauration</button>
        <div className="version-list">{versions.map((version) => <article className={`version-item ${version.revision === document.revision ? 'current' : ''}`} key={version.id}>
          <div><strong>Version {version.revision}{version.revision === document.revision ? ' · actuelle' : ''}</strong><small>{new Date(version.created_at).toLocaleString('fr-FR')}</small></div>
          {document.role === 'OWNER' && <button className="restore-button" disabled={busy || version.revision === document.revision} onClick={() => restore(version)}>Restaurer</button>}
        </article>)}</div>
      </section>
      <section className="document-tool-section">
        <div className="document-tool-heading"><h2>Publication</h2></div>
        <p className="tool-description">Créer un lien pour permettre aux visiteurs de télécharger le PDF.</p>
        <form className="tool-form" onSubmit={onCreateLink}><label>Nombre de téléchargements<input name="limit" type="number" min="1" max="100000" value={limit} onChange={(event) => setLimit(event.target.value)} required /></label><button className="primary">Créer le lien</button></form>
      </section>
      {document.role === 'OWNER' && <section className="document-tool-section">
        <div className="document-tool-heading"><h2>Collaboration</h2></div>
        <p className="tool-description">Inviter une personne ayant déjà créé son compte.</p>
        <form className="tool-form" onSubmit={share}><label>Adresse e-mail<input type="email" required value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} /></label><button className="secondary">Partager le document</button></form>
      </section>}
    </aside>
    <main className="document-editor-main">
      <div className="editor-heading"><div><p className="eyebrow">DOCUMENT · VERSION {document.revision}</p><h1>{document.title}</h1><p className="muted">Les modifications sont synchronisées entre les rédacteurs connectés.</p></div></div>
      <Suspense fallback={<div className="editor-card">Chargement de l’éditeur…</div>}><CollaborativeEditor documentId={document.id} initialRevision={document.revision} onRevision={onRevision} onCreditUpdate={onCreditUpdate} onProblem={onProblem} /></Suspense>
    </main>
  </div>;
}

function PublicDownload({ token }: { token: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.publicLink(token).then(setLink).catch((error: Error) => setStatus(error.message)); }, [token]);
  async function download() {
    setBusy(true); setStatus('Votre demande est enregistrée. Préparation du PDF…');
    try {
      const job = await api.reserve(token);
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await api.reservation(job.id);
        if (result.state === 'READY' && result.downloadUrl) { window.location.assign(result.downloadUrl); setStatus('Le téléchargement démarre.'); return; }
        if (result.state === 'FAILED') throw new Error(result.error ?? 'La génération du PDF a échoué.');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setStatus('Le PDF prend plus de temps que prévu. Rechargez cette page dans quelques instants.');
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="entry-screen"><section className="entry-card public-card"><img className="brand-mark brand-image" src="/Feather.jpeg" alt="Logo Atelier" /><p className="eyebrow">ÉDITION PARTAGÉE</p><h1>{link?.title ?? 'Chargement du document…'}</h1><p className="muted">Téléchargez le document au format PDF. Une place est réservée au moment de votre demande.</p>{link?.state === 'EXHAUSTED' || link?.state === 'EXPIRED' ? <div className="exhausted">Ce lien a atteint sa limite de téléchargements.</div> : <button className="primary full" onClick={download} disabled={!link || busy || link.state !== 'ACTIVE'}>{busy ? 'Préparation en cours…' : 'Demander le PDF'} <span>↓</span></button>}{status && <p className="download-status">{status}</p>}<small>{link ? `${link.remaining} téléchargement(s) restant(s)` : 'Le contenu n’est accessible qu’après une demande autorisée.'}</small></section></main>;
}
