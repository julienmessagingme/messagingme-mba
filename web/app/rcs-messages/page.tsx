'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listRcsMessages, deleteRcsMessage, listUserFields, type RcsMessage, type UserFieldDef } from '@/lib/api';
import { versBrouillonRcs, libelleFormatRcs, extraitRcs } from '@/lib/rcs';
import { versBrouillonCarrousel } from '@/lib/rcs-carrousel';
import { RcsMessageForm } from '@/components/RcsMessageForm';
import { RcsCarouselForm } from '@/components/RcsCarouselForm';
import { RcsPreview } from '@/components/RcsPreview';
import { RcsCarouselPreview } from '@/components/RcsCarouselPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { useT } from '@/lib/i18n';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { BoutonConfirme } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';
import { Icone } from '@/components/Icone';

/**
 * Contenu > Messages RCS : la bibliothèque des messages réutilisables du canal RCS.
 *
 * 🔴 SUR LE DESSIN DE CONTENU > TEMPLATES DEPUIS LE 2026-09-21 (Julien : « il faut que ça ait vraiment la même
 * gueule que les écrans WhatsApp template »). Un tableau pour la liste, la création dans un encadré avec son
 * sélecteur « Message simple | Carrousel », le formulaire dans une carte blanche avec son aperçu dans un cadre
 * de téléphone, et ce qui manque nommé sous le bouton.
 *
 * Différence de fond avec les templates WhatsApp, et c'est ce qui change tout à l'usage : un message RCS n'est
 * soumis à PERSONNE. Pas de validation, pas d'attente. On écrit, on enregistre, on envoie.
 *
 * ⚠️ BASCULER DE FORMAT NE PERD RIEN : les deux formulaires restent montés pendant la création, seul l'affiché
 * compte. L'écran des templates démonte le formulaire quitté ; ici, une saisie ne disparaît pas parce qu'on a
 * regardé l'autre format.
 *
 * ⚠️ UNE MODIFICATION N'A PAS DE SÉLECTEUR, comme un template : un message s'ouvre dans le formulaire de son
 * format. Changer de format, c'est créer un autre message.
 */
export default function RcsMessagesPage() {
  return <AppShell active="rcs-messages">{(session) => <RcsMessagesInner session={session} />}</AppShell>;
}

type Format = 'simple' | 'carrousel';

function RcsMessagesInner({ session }: { session: Session }) {
  const t = useT();
  const [items, setItems] = useState<RcsMessage[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [format, setFormat] = useState<Format>('simple');
  const [editing, setEditing] = useState<RcsMessage | null>(null);
  const [preview, setPreview] = useState<RcsMessage | null>(null);
  // Une génération par ouverture : rouvrir « Créer » repart de formulaires vierges, sans la saisie d'une
  // création abandonnée (la clé des formulaires la porte).
  const [ouverture, setOuverture] = useState(0);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await listRcsMessages(session.tenantId);
      setItems(r.messages);
    } catch (e) {
      setError(erreurDeChargement(e, t));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void reload(); }, [reload]);
  // `?? []` : une réponse sans `fields` (route absente, câblage de test) mettrait `undefined` dans l'état, et
  // le rendu suivant planterait sur `.filter`. Même garde que partout ailleurs sur une liste distante.
  useEffect(() => { listUserFields(session.tenantId).then((r) => setFields(r.fields ?? [])).catch(() => {}); }, [session.tenantId]);

  function ouvrirCreation() {
    setEditing(null);
    setFormat('simple');
    setOuverture((n) => n + 1);
    setCreating(true);
  }
  function fermer() {
    setCreating(false);
    setEditing(null);
  }
  async function apresEnregistrement() {
    fermer();
    await reload();
  }

  async function supprimer(m: RcsMessage) {
    setError(null);
    try {
      await deleteRcsMessage(session.tenantId, m.id);
      if (editing?.id === m.id) setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Suppression impossible', 'Delete failed'));
    }
  }

  const simpleEdite = editing ? versBrouillonRcs(editing.content) : null;
  const carrouselEdite = editing ? versBrouillonCarrousel(editing.content) : null;

  return (
    <div className="space-y-6">
      {editing ? (
        <section className="rounded-carte border border-brand-200 bg-brand-50/40 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-900">{t(`Modifier « ${editing.name} »`, `Edit “${editing.name}”`)}</h2>
            <button onClick={fermer} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          {carrouselEdite ? (
            <RcsCarouselForm
              key={editing.id}
              tenantId={session.tenantId}
              fields={fields}
              initial={{ id: editing.id, name: editing.name, brouillon: carrouselEdite }}
              onSaved={() => void apresEnregistrement()}
            />
          ) : simpleEdite ? (
            <RcsMessageForm
              key={editing.id}
              tenantId={session.tenantId}
              fields={fields}
              initial={{ id: editing.id, name: editing.name, brouillon: simpleEdite }}
              onSaved={() => void apresEnregistrement()}
            />
          ) : null}
        </section>
      ) : creating ? (
        <section className="rounded-carte border border-brand-200 bg-brand-50/40 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-900">{t('Nouveau message RCS', 'New RCS message')}</h2>
            <button onClick={fermer} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          <div className="inline-flex gap-1 rounded-controle bg-ink-100 p-1 text-xs" role="group" aria-label={t('Format du message', 'Message format')}>
            {(['simple', 'carrousel'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                aria-pressed={format === f}
                data-testid={`rcs-format-${f}`}
                className={`rounded-controle px-3 py-1 ${format === f ? 'bg-white font-medium text-brand-700' : 'text-ink-500 hover:text-ink-900'}`}
              >
                {f === 'simple' ? t('Message simple', 'Simple message') : t('Carrousel', 'Carousel')}
              </button>
            ))}
          </div>
          <p className="mb-4 mt-2 text-xs text-ink-500">
            {t('Aucune validation : un message RCS part tel qu’il est écrit, sous votre agent de marque.', 'No approval: an RCS message goes out as written, under your brand agent.')}
          </p>
          <div className={format === 'simple' ? '' : 'hidden'}>
            <RcsMessageForm key={`simple-${ouverture}`} tenantId={session.tenantId} fields={fields} onSaved={() => void apresEnregistrement()} />
          </div>
          <div className={format === 'carrousel' ? '' : 'hidden'}>
            <RcsCarouselForm key={`carrousel-${ouverture}`} tenantId={session.tenantId} fields={fields} onSaved={() => void apresEnregistrement()} />
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <TitrePage className="tabular-nums">{t('Messages RCS', 'RCS messages')} ({items.length})</TitrePage>
          <div className="flex items-center gap-3">
            <button onClick={() => void reload()} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
            {!creating && !editing && (
              <Bouton
                onClick={ouvrirCreation}
                data-testid="rcs-message-new"
              >
                <Icone nom="ajouter" />{t('Créer un message', 'Create a message')}
              </Bouton>
            )}
          </div>
        </div>
        {error && <p className="mb-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        {loading ? (
          <Squelette forme="lignes" />
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-500">
            {t('Aucun message : un message RCS part tel qu’il est écrit, sans validation.', 'No messages yet: an RCS message goes out as written, with no approval.')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-carte border border-ink-200 bg-white" data-testid="rcs-message-list">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-ink-50 text-left text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('Nom', 'Name')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Format', 'Format')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Texte', 'Text')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('Actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((m) => {
                  const editable = versBrouillonRcs(m.content) !== null || versBrouillonCarrousel(m.content) !== null;
                  return (
                    <tr key={m.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => setPreview(m)}
                          disabled={m.content === null}
                          className="text-left text-sm font-medium text-brand-600 hover:underline disabled:text-ink-500 disabled:no-underline"
                          title={t("Voir l’aperçu", 'View preview')}
                        >
                          {m.name}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-ink-500" data-testid={`rcs-message-format-${m.id}`}>{t(...libelleFormatRcs(m.content))}</td>
                      <td className="max-w-xs truncate px-4 py-2.5 text-xs text-ink-500">{extraitRcs(m.content)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-3 text-xs">
                          {editable ? (
                            <button
                              onClick={() => { setCreating(false); setEditing(m); }}
                              data-testid={`rcs-message-editer-${m.id}`}
                              className="font-medium text-brand-600 hover:text-brand-700"
                            >
                              {t('Modifier', 'Edit')}
                            </button>
                          ) : (
                            <span
                              className="text-ink-500"
                              title={m.content === null
                                ? t('Contenu illisible : il ne peut pas être ouvert ici.', 'Unreadable content: it cannot be opened here.')
                                : t('Une carte à titre (créée par l’API) ne se modifie pas ici.', 'A titled card (created through the API) cannot be edited here.')}
                            >
                              {t('Modifier', 'Edit')}
                            </span>
                          )}
                          <BoutonConfirme question={t(`Supprimer « ${m.name} » ?`, `Delete "${m.name}"?`)} onConfirme={() => void supprimer(m)} libelleConfirmer={t('Supprimer', 'Delete')} className="font-medium text-danger hover:text-danger-700">{t('Supprimer', 'Delete')}</BoutonConfirme>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <ApercuMessage message={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** L'aperçu d'un message au clic sur son nom, dans le cadre de téléphone, comme un template. */
function ApercuMessage({ message, onClose }: { message: RcsMessage; onClose: () => void }) {
  const t = useT();
  const simple = versBrouillonRcs(message.content);
  const carrousel = versBrouillonCarrousel(message.content);
  return (
    <Modale
      titre={message.name}
      sousTitre={t(...libelleFormatRcs(message.content))}
      taille="petite"
      testId="rcs-message-apercu"
      onClose={onClose}
    >
      <RcsPhoneFrame>
        {carrousel ? (
          <RcsCarouselPreview brouillon={carrousel} sansFond />
        ) : simple ? (
          <RcsPreview brouillon={simple} sansFond />
        ) : (
          <p className="text-xs text-ink-500">{t('Ce format ne se dessine pas ici (carte à titre).', 'This format cannot be drawn here (titled card).')}</p>
        )}
      </RcsPhoneFrame>
    </Modale>
  );
}
