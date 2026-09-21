'use client';

import { useState } from 'react';
import { createRcsMessage, updateRcsMessage, type UserFieldDef } from '@/lib/api';
import {
  versMessageRcs, maxTexteRcs, manquesMessageRcs, MAX_BOUTONS_RCS, MAX_BOUTONS_CARTE, type BrouillonRcs,
} from '@/lib/rcs';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { RcsPreview } from '@/components/RcsPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { ListeManques } from '@/components/ListeManques';
import { Field } from '@/components/TemplateForm';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/** Un message simple qu'on modifie : son identifiant, son nom, et son contenu déjà relu en brouillon. */
export interface MessageSimpleInitial {
  id: string;
  name: string;
  brouillon: BrouillonRcs;
}

/**
 * LE FORMULAIRE D'UN MESSAGE RCS SIMPLE (texte, ou carte dès qu'il y a un visuel), sur le dessin de
 * `TemplateForm` : le formulaire à gauche, l'« Aperçu RCS » dans un cadre de téléphone à droite, ce qui manque
 * sous le formulaire, et un bouton pleine largeur.
 *
 * 🔴 SORTI DE LA PAGE LE 2026-09-21 SANS CHANGER CE QU'IL POSTE (Julien : « il faut que ça ait vraiment la même
 * gueule que les écrans WhatsApp template »). Ce qui part reste `versMessageRcs(brouillon)`, et les
 * `data-testid` sont ceux d'avant : les cas de `rcs-messages.spec.ts` passent sans être réécrits, et c'est ce
 * qui prouve que le dessin n'a rien changé au contenu.
 *
 * 🔴 LE BOUTON EST GRISÉ SI ET SEULEMENT SI `manquesMessageRcs` N'EST PAS VIDE : la même liste décide du bouton
 * et de ce qu'on affiche, sans quoi le bouton se grise pour une raison qu'elle ne nomme pas.
 */
export function RcsMessageForm({ tenantId, fields, initial, onSaved }: {
  tenantId: string;
  fields: UserFieldDef[];
  initial?: MessageSimpleInitial;
  onSaved: () => void;
}) {
  const t = useT();
  const [nom, setNom] = useState(initial?.name ?? '');
  const [brouillon, setBrouillon] = useState<BrouillonRcs>(initial?.brouillon ?? { text: '', imageUrl: '', suggestions: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 🔴 Où les boutons sont accrochés décide de leur APPARENCE sur le téléphone, et ce n'est pas nous qui la
  // dessinons. Dans la CARTE : pleine largeur, empilés, persistants (4 maximum). Sous le MESSAGE : petites
  // pastilles en ligne, éphémères (11 maximum). `RcsPreview` dessine cette différence, `versMessageRcs`
  // l'écrit ; ici on n'a besoin que de savoir s'il y a un visuel.
  const avecImage = brouillon.imageUrl.trim() !== '';
  const manques = manquesMessageRcs(nom, brouillon).map((m) => t(...m));
  const canSubmit = manques.length === 0 && !busy;

  async function enregistrer() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const contenu = versMessageRcs(brouillon);
      if (initial) await updateRcsMessage(tenantId, initial.id, nom.trim(), contenu);
      else await createRcsMessage(tenantId, nom.trim(), contenu);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <Field label={t('Nom (interne)', 'Name (internal)')}>
            <input
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              maxLength={120}
              data-testid="rcs-message-name"
              className={inputCls}
              placeholder={t('Offre du jour', 'Daily offer')}
            />
          </Field>

          <Field label={t('Image d’en-tête (facultatif)', 'Header image (optional)')}>
            <ChampImageHebergee
              tenantId={tenantId}
              valeur={brouillon.imageUrl}
              onChange={(imageUrl) => setBrouillon((b) => ({ ...b, imageUrl }))}
            />
            <p className="mt-1 text-[11px] text-ink-400">
              {t('JPEG, PNG ou GIF, 2 Mo maximum. Avec un visuel, le message devient une carte : l’image s’affiche au-dessus du texte et les boutons passent en liste.', 'JPEG, PNG or GIF, 2 MB maximum. With a visual, the message becomes a card: the image shows above the text and the buttons switch to a list.')}
            </p>
          </Field>

          <div className="mt-3">
            <ChampCorpsVariables
              valeur={brouillon.text}
              onChange={(text) => setBrouillon((b) => ({ ...b, text }))}
              fields={fields}
              label={t('Message', 'Message')}
              testId="rcs-message-text"
              max={maxTexteRcs(brouillon.imageUrl)}
            />
            <p className="mt-1 text-[11px] text-ink-400">
              {t('« + Variable » insère un champ du contact : il s’affiche comme une étiquette et sera remplacé à l’envoi. Sans valeur sur la fiche, il laisse un blanc.', '“+ Variable” inserts a contact field: it shows as a tag and is filled in at send time. With no value on the record, it leaves a blank.')}
            </p>
          </div>

          <Field label={t('Boutons', 'Buttons')}>
            <RcsButtonsEditor
              boutons={brouillon.suggestions}
              onChange={(suggestions) => setBrouillon((b) => ({ ...b, suggestions }))}
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
          </Field>

          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <ListeManques manques={manques} testId="rcs-message-manques" busy={busy} />
          <button
            type="button"
            onClick={() => void enregistrer()}
            disabled={!canSubmit}
            data-testid="rcs-message-save"
            className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Enregistrement…', 'Saving…') : initial ? t('Enregistrer les modifications', 'Save changes') : t('Créer le message', 'Create message')}
          </button>
        </div>

        {/* Colonne aperçu, collante quand elle est À CÔTÉ, comme celle de `TemplateForm`. */}
        <div data-testid="apercu-rcs" className="lg:sticky lg:top-4 lg:h-fit">
          <RcsPhoneFrame>
            <RcsPreview brouillon={brouillon} sansFond />
          </RcsPhoneFrame>
        </div>
      </div>
    </div>
  );
}
