'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listTags, createTag, renameTag, deleteTag, type TagCount } from '@/lib/api';

export default function TagsPage() {
  return <AppShell active="tags">{(session) => <TagsInner session={session} />}</AppShell>;
}

function TagsInner({ session }: { session: Session }) {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newTag, setNewTag] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setTags((await listTags(session.tenantId)).tags);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
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
      setError(err instanceof Error ? err.message : 'Renommage impossible');
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
      setError(err instanceof Error ? err.message : 'Création impossible');
    }
  }

  async function remove(tag: string) {
    if (!window.confirm(`Supprimer le tag « ${tag} » de tous les contacts ?`)) return;
    setError(null);
    try {
      await deleteTag(session.tenantId, tag);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suppression impossible');
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Tags</h2>
        <p className="mt-1 text-sm text-ink-500">Crée un tag réutilisable, ou renomme/supprime (répercuté sur tous les contacts qui le portent).</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder="Nouveau tag…"
          className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button onClick={create} disabled={newTag.trim() === ''} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">Créer un tag</button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">Tags ({tags.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Chargement…</p>
        ) : tags.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">Aucun tag. Crée-en un ci-dessus, ou ils apparaissent automatiquement via l&apos;import CSV ou la fiche d&apos;un contact.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">Tag</th>
                <th className="px-5 py-2 font-medium">Contacts</th>
                <th className="px-5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.tag} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3">
                    {editing === t.tag ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(t.tag); if (e.key === 'Escape') setEditing(null); }}
                        className="rounded-lg border border-ink-300 px-2 py-1 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">{t.tag}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-ink-500">{t.count}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-3">
                      {editing === t.tag ? (
                        <>
                          <button onClick={() => void saveRename(t.tag)} className="font-medium text-brand-600 hover:text-brand-700">Enregistrer</button>
                          <button onClick={() => setEditing(null)} className="text-ink-400 hover:text-ink-700">Annuler</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditing(t.tag); setDraft(t.tag); }} className="text-ink-600 hover:text-ink-900">Renommer</button>
                          <button onClick={() => void remove(t.tag)} className="text-coral hover:text-coral/80">Supprimer</button>
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
    </div>
  );
}
