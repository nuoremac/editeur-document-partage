const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type Person = { id: string; name: string; email: string; role: 'EDITOR' | 'ADMIN' };
export type DocumentSummary = { id: string; title: string; revision: number; updated_at: string; role: string };
export type Document = { id: string; title: string; content: string; revision: number; updated_at: string; role: string };
export type Link = { token: string; title: string; initial_limit: number; remaining: number; state: string; url?: string };
export type Credit = { used: number; limit: number; remaining: number };
export type Version = { id: string; revision: number; title: string; created_by: string; created_at: string };
export type ServerNotification = { id: string; type: string; title: string; message: string; created_at: string; state: string };
export type AdminOverview = {
  metrics: { accounts: number; documents: number; links: number; active_links: number; open_documents: number; blocked_people: number; reservations: number; pending_pdfs: number; pending_notifications: number };
  people: { id: string; name: string; email: string; role: string; created_at: string; blocked: boolean }[];
  blockedPeople: { id: string; name: string; email: string; role: string; created_at: string; blocked: boolean }[];
  activeLinks: { id: string; token: string; title: string; remaining: number; initial_limit: number; created_at: string; expires_at: string | null }[];
  openDocuments: { id: string; title: string; revision: number; updated_at: string; editors: string[] }[];
  recentReservations: { id: string; state: string; revision: number; created_at: string; title: string }[];
};

async function request<T>(path: string, person?: Person, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  void person;
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: 'include' });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error ?? 'La requête a échoué.');
  return result as T;
}

export const api = {
  register: (name: string, email: string, password: string) => request<Person>('/api/auth/register', undefined, { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  login: (email: string, password: string) => request<Person>('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<Person>('/api/auth/me'),
  logout: () => request<void>('/api/auth/logout', undefined, { method: 'POST' }),
  documents: (person: Person) => request<{ documents: DocumentSummary[] }>('/api/documents', person),
  document: (person: Person, id: string) => request<Document>(`/api/documents/${id}`, person),
  createDocument: (person: Person, title: string) => request<Document>('/api/documents', person, { method: 'POST', body: JSON.stringify({ title }) }),
  saveContent: (person: Person, doc: Document, content: string) => request<Document>(`/api/documents/${doc.id}/content`, person, { method: 'PUT', body: JSON.stringify({ content, baseRevision: doc.revision }) }),
  createLink: (person: Person, id: string, limit: number) => request<Link & { url: string }>(`/api/documents/${id}/links`, person, { method: 'POST', body: JSON.stringify({ limit }) }),
  links: (person: Person) => request<{ links: Link[] }>('/api/links', person),
  credit: (person: Person) => request<Credit>('/api/credit', person),
  notifications: () => request<{ notifications: ServerNotification[] }>('/api/notifications'),
  versions: (person: Person, id: string) => request<{ versions: Version[] }>(`/api/documents/${id}/versions`, person),
  createVersion: (person: Person, id: string) => request<Version>(`/api/documents/${id}/versions`, person, { method: 'POST' }),
  restore: (person: Person, id: string, versionId: string) => request<Document>(`/api/documents/${id}/versions/${versionId}/restore`, person, { method: 'POST' }),
  share: (person: Person, id: string, email: string) => request<void>(`/api/documents/${id}/share`, person, { method: 'POST', body: JSON.stringify({ email }) }),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  blockPerson: (id: string, reason: string, durationHours: number) => request(`/api/admin/people/${id}/blocks`, undefined, { method: 'POST', body: JSON.stringify({ reason, durationHours }) }),
  unblockPerson: (id: string) => request<void>(`/api/admin/people/${id}/blocks`, undefined, { method: 'DELETE' }),
  publicLink: (token: string) => request<Link>(`/api/public/links/${token}`),
  reserve: (token: string) => request<{ id: string; state: string }>(`/api/public/links/${token}/reservations`, undefined, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() } }),
  reservation: (id: string) => request<{ state: string; downloadUrl: string | null; error: string | null }>(`/api/public/reservations/${id}`),
};
