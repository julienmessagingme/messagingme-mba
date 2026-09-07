'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listRcsMessages, createRcsMessage, updateRcsMessage, deleteRcsMessage, listUserFields,
  type RcsMessage, type UserFieldDef,
} from '@/lib/api';
import {
  versMessageRcs, versBrouillonRcs, maxTexteRcs, MAX_BOUTONS_RCS, MAX_BOUTONS_CARTE,
  type BrouillonRcs,
} from '@/lib/rcs';
import { boutonPret } from '@/lib/rcs-boutons';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { RcsPreview } from '@/components/RcsPreview';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Contenu > Messages RCS : la bibliothèque des messages réutilisables du canal RCS.
 *
 * Différence de fond avec les templates WhatsApp, et c'est ce qui change tout à l'usage : un message RCS
 * n'est soumis à PERSONNE. Pas de validation, pas d'attente. On écrit, on enregistre, on envoie. La
 * bibliothèque sert donc à réutiliser un message sur plusieurs campagnes et scénarios, pas à le faire
 * approuver.
 *
 * Trois choses se composent ici : le texte (avec ses variables `{{champ}}` et ses emojis), un visuel
 * d'en-tête facultatif, et jusqu'à 11 boutons. Le format envoyé se DÉDUIT de la saisie : TEXTE sans visuel,
 * CARTE dès qu'il y en a un (`web/lib/rcs.ts`). Le CARROUSEL n'a pas de composeur ; un message de ce format
 * est listé, signalé, et non éditable ici plutôt qu'ouvert à moitié.
 */
export default function RcsMessagesPage() {
  return <AppShell active="rcs-messages">{(session) => <RcsMessagesInner session={session} />}</AppShell>;
}

type Brouillon = BrouillonRcs & { name: string };
const VIDE: Brouillon = { name: '', text: '', imageUrl: '', suggestions: [] };

function RcsMessagesInner({ session }: { session: Session }) {
  const t = useT();
  const [items, setItems] = useState<RcsMessage[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Brouillon>(VIDE);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await listRcsMessages(session.tenantId);
      setItems(r.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void reload(); }, [reload]);
  // `?? []` : une réponse sans `fields` (route absente, câblage de test) mettrait `undefined` dans l'état, et
  // le rendu suivant planterait sur `.filter`. Même garde que partout ailleurs sur une liste distante.
  useEffect(() => { listUserFields(session.tenantId).then((r) => setFields(r.fields ?? [])).catch(() => {}); }, [session.tenantId]);

  const maxTexte = maxTexteRcs(form.imageUrl);
  // 🔴 Où les boutons sont accrochés décide de leur APPARENCE sur le téléphone, et ce n'est pas nous qui la
  // dessinons. Dans la CARTE : pleine largeur, empilés, persistants (4 maximum). Sous le MESSAGE : petites
  // pastilles en ligne, éphémères (11 maximum). `RcsPreview` dessine cette différence, `versMessageRcs`
  // l'écrit ; ici on n'a besoin que de savoir s'il y a un visuel.
  const avecImage = form.imageUrl.trim() !== '';

  // Un bouton lien sans URL, ou un bouton appel sans numéro, partirait chez le provider et serait refusé.
  // On bloque l'enregistrement plutôt que de laisser découvrir l'erreur au moment de l'envoi.
  // `boutonPret` : un bouton incomplet (lien sans URL, agenda sans date) serait refusé par le serveur, et son
  // refus ferait échouer l'enregistrement du message ENTIER. Même règle sur les trois écrans qui composent.
  const pret = form.name.trim() !== '' && form.text.trim() !== '' && form.text.length <= maxTexte
    && form.suggestions.every(boutonPret);

  async function enregistrer() {
    if (!pret || editing === null) return;
    setBusy(true);
    setError(null);
    try {
      const contenu = versMessageRcs(form);
      if (editing === 'new') await createRcsMessage(session.tenantId, form.name.trim(), contenu);
      else await updateRcsMessage(session.tenantId, editing, form.name.trim(), contenu);
      setEditing(null);
      setForm(VIDE);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  async function supprimer(m: RcsMessage) {
    if (!window.confirm(t(`Supprimer « ${m.name} » ?`, `Delete "${m.name}"?`))) return;
    setError(null);
    try {
      await deleteRcsMessage(session.tenantId, m.id);
      if (editing === m.id) { setEditing(null); setForm(VIDE); }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Suppression impossible', 'Delete failed'));
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{t('Messages RCS', 'RCS messages')}</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {t("Aucune validation à obtenir : un message RCS part tel qu'il est écrit, sous votre agent de marque.", 'No approval needed: an RCS message goes out as written, under your brand agent.')}
          </p>
        </div>
        <button
          onClick={() => { setEditing('new'); setForm(VIDE); }}
          data-testid="rcs-message-new"
          className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
        >
          + {t('Nouveau message', 'New message')}
        </button>
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editing !== null && (
        <div className="mb-6 rounded-xl border border-ink-200 p-4">
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom (interne)', 'Name (internal)')}</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={120}
              data-testid="rcs-message-name"
              className={`${inputCls} max-w-md`}
              placeholder={t('Offre du jour', 'Daily offer')}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Image d’en-tête (facultatif)', 'Header image (optional)')}</label>
              <ChampImageHebergee
                tenantId={session.tenantId}
                valeur={form.imageUrl}
                onChange={(imageUrl) => setForm((f) => ({ ...f, imageUrl }))}
              />
              <p className="mt-1 text-[11px] text-ink-400">
                {t('JPEG, PNG ou GIF, 2 Mo maximum. Avec un visuel, le message devient une carte : l’image s’affiche au-dessus du texte et les boutons passent en liste.', 'JPEG, PNG or GIF, 2 MB maximum. With a visual, the message becomes a card: the image shows above the text and the buttons switch to a list.')}
              </p>

              <div className="mt-3">
                <ChampCorpsVariables
                  valeur={form.text}
                  onChange={(text) => setForm((f) => ({ ...f, text }))}
                  fields={fields}
                  label={t('Message', 'Message')}
                  testId="rcs-message-text"
                  max={maxTexte}
                />
              </div>
              <p className="mt-1 text-[11px] text-ink-400">
                {t('« + Variable » insère un champ du contact : il s’affiche comme une étiquette et sera remplacé à l’envoi. Sans valeur sur la fiche, il laisse un blanc.', '“+ Variable” inserts a contact field: it shows as a tag and is filled in at send time. With no value on the record, it leaves a blank.')}
              </p>

              <label className="mb-1 mt-3 block text-xs font-medium text-ink-600">{t('Boutons', 'Buttons')}</label>
              <RcsButtonsEditor
                boutons={form.suggestions}
                onChange={(suggestions) => setForm((f) => ({ ...f, suggestions }))}
                max={avecImage ? MAX_BOUTONS_CARTE : MAX_BOUTONS_RCS}
                dateFields={fields}
              />
              <p className="mt-1 text-[11px] text-ink-400">
                {avecImage
                  ? t('Avec un visuel, jusqu’à 4 boutons : ils s’affichent en LISTE pleine largeur dans la carte, et y restent. 25 caractères chacun.', 'With a visual, up to 4 buttons: they show as a full-width LIST inside the card and stay there. 25 characters each.')
                  : t('Sans visuel, jusqu’à 11 boutons : ils s’affichent en petites PASTILLES sous la bulle, et disparaissent dès que la conversation avance. Ajoutez une image pour des boutons en liste. 25 caractères chacun.', 'With no visual, up to 11 buttons: they show as small CHIPS under the bubble and vanish as the conversation moves on. Add an image to get list buttons. 25 characters each.')}
              </p>
              <p className="mt-1 text-[11px] text-ink-400">
                {t('Les variables ne sont pas remplacées dans un libellé. Un bouton « Réponse » est le seul qui devienne une sortie à relier dans un scénario.', 'Variables are not substituted in a label. A "Reply" button is the only one that becomes an output to connect in a scenario.')}
              </p>
            </div>

            {/* Aperçu : la bulle telle que le contact la verra. Mint, comme le canal RCS dans l'inbox. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Aperçu', 'Preview')}</label>
              <RcsPreview brouillon={form} />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => void enregistrer()}
              disabled={!pret || busy}
              data-testid="rcs-message-save"
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
            >
              {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
            </button>
            <button onClick={() => { setEditing(null); setForm(VIDE); }} className="text-sm text-ink-500 hover:underline">
              {t('Annuler', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun message pour le moment.', 'No message yet.')}</p>
      ) : (
        <div className="divide-y divide-ink-100 rounded-xl border border-ink-200" data-testid="rcs-message-list">
          {items.map((m) => {
            const b = versBrouillonRcs(m.content);
            return (
              <div key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-800">
                    {b?.imageUrl ? '🖼️ ' : ''}{m.name}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {b ? b.text : <span className="text-amber-700">{t('Format non éditable ici (carrousel, ou carte à titre)', 'Format not editable here (carousel, or titled card)')}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {b && (
                    <button onClick={() => { setEditing(m.id); setForm({ name: m.name, ...b }); }} className="text-sm text-brand-600 hover:underline">
                      {t('Modifier', 'Edit')}
                    </button>
                  )}
                  <button onClick={() => void supprimer(m)} className="text-sm text-ink-400 hover:text-coral">
                    {t('Supprimer', 'Delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
