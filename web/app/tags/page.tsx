'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listTags, createTag, renameTag, deleteTag, listContacts, type TagCount, type Contact } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fieldValue } from '@/lib/fields';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';

export default function TagsPage() {
  return <AppShell active="tags">{(session) => <TagsInner session={session} />}</AppShell>;
}

function TagsInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
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
      setError(erreurDeChargement(err, t));
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
    if (!(await confirmer({ titre: t('Supprimer l’étiquette', 'Delete the tag'), message: t(`Supprimer l’étiquette « ${tag} » de tous les contacts ?`, `Delete the tag "${tag}" from all contacts?`), confirmer: t('Supprimer', 'Delete') }))) return;
    setError(null);
    try {
      await deleteTag(session.tenantId, tag);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  return (
    <div className="max-w-formulaire space-y-6">
      <div>
        <TitrePage>{t('Étiquettes', 'Tags')}</TitrePage>
        <IntroPage>{t('Renommer ou supprimer une étiquette s’applique à tous les contacts qui la portent.', 'Renaming or deleting a tag applies to every contact that carries it.')}</IntroPage>
      </div>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('Nouvelle étiquette…', 'New tag…')}
          className="flex-1 rounded-controle border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <Bouton onClick={create} disabled={newTag.trim() === ''}>{t('Créer une étiquette', 'Create a tag')}</Bouton>
      </div>

      <div className="overflow-hidden rounded-carte border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Étiquettes', 'Tags')} ({tags.length})</div>
        {loading ? (
          <Squelette forme="lignes" className="px-5 py-6" />
        ) : tags.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucune étiquette. Créez-en une ci-dessus : elles naissent aussi d’un import CSV ou d’une fiche contact.', 'No tags yet. Create one above: they also come from a CSV import or a contact record.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="px-5 py-2 font-medium">{t('Étiquette', 'Tag')}</th>
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
                        className="rounded-controle border border-ink-300 px-2 py-1 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                    ) : (
                      <span className="font-medium text-ink-900">{tc.tag}</span>
                    )}
                    {tc.code && <div className="mt-0.5 font-mono text-xs text-ink-500" title={t('Code public (API)', 'Public code (API)')}>{tc.code}</div>}
                  </td>
                  <td className="px-5 py-3">
                    {tc.count > 0 ? (
                      <button onClick={() => setContactsOf(tc.tag)} className="font-medium text-brand-600 hover:underline" title={t('Voir les contacts', 'View contacts')}>{tc.count}</button>
                    ) : (
                      <span className="text-ink-500">0</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-3">
                      {editing === tc.tag ? (
                        <>
                          <button onClick={() => void saveRename(tc.tag)} className="font-medium text-brand-600 hover:text-brand-700">{t('Enregistrer', 'Save')}</button>
                          <button onClick={() => setEditing(null)} className="text-ink-500 hover:text-ink-900">{t('Annuler', 'Cancel')}</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditing(tc.tag); setDraft(tc.tag); }} className="text-ink-500 hover:text-ink-900">{t('Renommer', 'Rename')}</button>
                          <button onClick={() => void remove(tc.tag)} className="text-danger hover:text-danger-500">{t('Supprimer', 'Delete')}</button>
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
      .catch((e) => { if (alive) setError(erreurDeChargement(e, t)); });
    return () => { alive = false; };
  }, [tenantId, tag, t]);

  return (
    <Modale titre={t('Contacts du tag', 'Contacts with this tag')} sousTitre={tag} taille="petite" onClose={onClose}>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
      {!contacts ? (
        <Squelette forme="lignes" />
      ) : contacts.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun contact avec ce tag.', 'No contacts with this tag.')}</p>
      ) : (
        <>
          <div className="divide-y divide-ink-100">
            {contacts.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="truncate font-medium text-ink-900">{c.profileName ?? (fieldValue(c, 'prenom') ?? '-')}</span>
                <span className="shrink-0 font-mono text-xs text-ink-500">{c.phoneE164 ?? '-'}</span>
              </div>
            ))}
          </div>
          {contacts.length === 500 && <p className="mt-2 text-xs text-ink-500">{t('Affichage limité aux 500 premiers contacts.', 'Showing the first 500 contacts only.')}</p>}
        </>
      )}
    </Modale>
  );
}

