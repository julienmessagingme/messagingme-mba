'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listTags, createTag, renameTag, deleteTag, listContacts, type TagCount, type Contact } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function TagsPage() {
  return <AppShell active="tags">{(session) => <TagsInner session={session} />}</AppShell>;
}

function TagsInner({ session }: { session: Session }) {
  const t = useT();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newTag, setNewTag] = useState('');
  const [contactsOf, setContactsOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTags((await listTags(session.tenantId)).tags);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveRename(from: string) {
    const to = draft.trim();
    if (!to || to === from) { setEditing(null); return; }
    setError(null);
    try {
      await renameTag(session.tenantId, from, to);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Renommage impossible', 'Unable to rename'));
    }
  }

  async function create() {
    const name = newTag.trim();
    if (!name) return;
    setError(null);
    try {
      await createTag(session.tenantId, name);
      setNewTag('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Unable to create'));
    }
  }

  async function remove(tag: string) {
    if (!window.confirm(t(`Supprimer le tag « ${tag} » de tous les contacts ?`, `Delete the tag "${tag}" from all contacts?`))) return;
    setError(null);
    try {
      await deleteTag(session.tenantId, tag);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Tags', 'Tags')}</h2>
        <p className="mt-1 text-sm text-ink-500">{t('Crée un tag réutilisable, ou renomme/supprime (répercuté sur tous les contacts qui le portent).', 'Create a reusable tag, or rename/delete it (applied to every contact that carries it).')}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('Nouveau tag…', 'New tag…')}
          className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button onClick={create} disabled={newTag.trim() === ''} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">{t('Créer un tag', 'Create a tag')}</button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Tags', 'Tags')} ({tags.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : tags.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t("Aucun tag. Crée-en un ci-dessus, ou ils apparaissent automatiquement via l'import CSV ou la fiche d'un contact.", "No tags yet. Create one above, or they appear automatically through CSV import or a contact's profile.")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Tag', 'Tag')}</th>
                <th className="px-5 py-2 font-medium">{t('Contacts', 'Contacts')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tc) => (
                <tr key={tc.tag} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3">
                    {editing === tc.tag ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(tc.tag); if (e.key === 'Escape') setEditing(null); }}
                        className="rounded-lg border border-ink-300 px-2 py-1 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">{tc.tag}</span>
                    )}
                    {tc.code && <div className="mt-0.5 font-mono text-[10px] text-ink-300" title={t('Code public (API)', 'Public code (API)')}>{tc.code}</div>}
                  </td>
                  <td className="px-5 py-3">
                    {tc.count > 0 ? (
                      <button onClick={() => setContactsOf(tc.tag)} className="font-medium text-brand-600 hover:underline" title={t('Voir les contacts', 'View contacts')}>{tc.count}</button>
                    ) : (
                      <span className="text-ink-400">0</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-3">
                      {editing === tc.tag ? (
                        <>
                          <button onClick={() => void saveRename(tc.tag)} className="font-medium text-brand-600 hover:text-brand-700">{t('Enregistrer', 'Save')}</button>
                          <button onClick={() => setEditing(null)} className="text-ink-400 hover:text-ink-700">{t('Annuler', 'Cancel')}</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditing(tc.tag); setDraft(tc.tag); }} className="text-ink-600 hover:text-ink-900">{t('Renommer', 'Rename')}</button>
                          <button onClick={() => void remove(tc.tag)} className="text-coral hover:text-coral/80">{t('Supprimer', 'Delete')}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {contactsOf && <TagContactsModal tenantId={session.tenantId} tag={contactsOf} onClose={() => setContactsOf(null)} />}
    </div>
  );
}

/** Liste des contacts portant un tag (clic sur le nombre). Lecture seule. */
function TagContactsModal({ tenantId, tag, onClose }: { tenantId: string; tag: string; onClose: () => void }) {
  const t = useT();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listContacts(tenantId, { tag, limit: 500 })
      .then((r) => { if (alive) setContacts(r.contacts); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : t('Chargement impossible', 'Unable to load')); });
    return () => { alive = false; };
  }, [tenantId, tag, t]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{t('Contacts du tag', 'Contacts with this tag')}</h3>
            <p className="text-xs text-ink-400"><span className="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700">{tag}</span></p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!contacts ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : contacts.length === 0 ? (
          <p className="text-sm text-ink-500">{t('Aucun contact avec ce tag.', 'No contacts with this tag.')}</p>
        ) : (
          <>
            <div className="divide-y divide-ink-100">
              {contacts.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="truncate font-medium text-ink-900">{c.profileName ?? (fieldValueOf(c, 'prenom') ?? '-')}</span>
                  <span className="shrink-0 font-mono text-xs text-ink-500">{c.phoneE164 ?? '-'}</span>
                </div>
              ))}
            </div>
            {contacts.length === 500 && <p className="mt-2 text-[11px] text-ink-400">{t('Affichage limité aux 500 premiers contacts.', 'Showing the first 500 contacts only.')}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function fieldValueOf(c: Contact, key: string): string | null {
  const v = (c.fields ?? {})[key] ?? (c.fields ?? {})[key.toLowerCase()];
  return v == null || String(v).trim() === '' ? null : String(v);
}
