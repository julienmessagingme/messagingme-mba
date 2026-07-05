'use client';

import { getSession, clearSession } from './session';

const BASE = '/api/backend';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = getSession();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (session) headers.set('authorization', `Bearer ${session.token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Session expirée, reconnecte-toi.');
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Erreur ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export interface LoginResult {
  token: string;
  user: { email: string; role: string; tenantId: string };
}
export function login(email: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export interface Contact {
  id: string;
  phoneE164: string | null;
  profileName: string | null;
  optInStatus: string;
  fields: Record<string, unknown>;
  createdAt: string;
}
export function listContacts(tenantId: string): Promise<{ contacts: Contact[] }> {
  return request<{ contacts: Contact[] }>(`/tenants/${tenantId}/contacts`);
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ line: number; reason: string }>;
}
export function importCsv(tenantId: string, csv: string, optIn: boolean): Promise<ImportReport> {
  return request<ImportReport>(`/tenants/${tenantId}/contacts/import`, {
    method: 'POST',
    body: JSON.stringify({ csv, optIn }),
  });
}
