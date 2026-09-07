'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { estEnLigne, type WorkflowSummary } from '@/lib/api';
import { inputCls } from '@/lib/ui';
import { MAX_PHRASE, MAX_TEXTE_POST, type LienChaine } from '@/lib/api-chaine';
import { imageAffichable, phraseAcceptable, pretAPublier, resteAAfficher, type BrouillonChaine } from '@/lib/chaine-apercu';

/**
 * Le composeur : ce qu'on écrit, l'image, et le lien de scénario qu'on rattache.
 *
 * 🔴 CE QUE LE COMPOSEUR NE FAIT PAS : il ne fabrique ni adresse `wa.me` ni texte pré-rempli. Créer un lien
 * est un appel au serveur, qui tire le jeton et compose l'adresse ; le composeur ne fait que choisir un lien
 * existant ou en demander un nouveau. C'est ce qui garantit qu'une seule composition existe.
 *
 * 🔴 UN LIEN N'EST PAS REPOINTABLE. Un autre scénario veut un autre lien, donc un autre jeton, donc une
 * autre mesure de conversion. L'écran propose de créer, jamais de modifier.
 */

export interface ChaineComposeurProps {
  brouillon: BrouillonChaine;
  onChange: (b: BrouillonChaine) => void;
  /** Les liens déjà créés, tels que `GET /links` les rend, adresse comprise. */
  liens: LienChaine[];
  scenarios: WorkflowSummary[];
  /** `null` = aucun numéro WhatsApp connecté : aucun lien n'est créable, le serveur refuse en 409. */
  phone: string | null;
  busy: boolean;
  onCreerLien: (input: { workflowId: string; phrase: string }) => Promise<void>;
  onPublier: () => Promise<void>;
}

export function ChaineComposeur(props: ChaineComposeurProps) {
  const t = useT();
  const { brouillon, onChange, liens, scenarios, phone, busy } = props;
  const [creation, setCreation] = useState(false);

  const image = brouillon.imageUrl.trim();
  const imageRefusee = image !== '' && imageAffichable(image) === null;
  const reste = resteAAfficher(brouillon.texte.length, MAX_TEXTE_POST);

  return (
    <div className="space-y-4" data-testid="chaine-composeur">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-600">{t('Message', 'Message')}</span>
        <textarea
          className={`${inputCls} min-h-[130px]`}
          value={brouillon.texte}
          onChange={(e) => onChange({ ...brouillon, texte: e.target.value })}
          placeholder={t('Ce que tes abonnés vont lire…', 'What your subscribers will read…')}
          data-testid="chaine-texte"
        />
        {reste !== null ? (
          <span
            className={`mt-1 block text-xs tabular-nums ${reste < 0 ? 'text-coral' : 'text-ink-400'}`}
            data-testid="chaine-texte-reste"
          >
            {reste < 0
              ? t(`${-reste} caractères de trop`, `${-reste} characters too many`)
              : t(`${reste} caractères restants`, `${reste} characters left`)}
          </span>
        ) : null}
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-600">
          {t('Image (adresse https, facultatif)', 'Image (https address, optional)')}
        </span>
        <input
          className={inputCls}
          value={brouillon.imageUrl}
          onChange={(e) => onChange({ ...brouillon, imageUrl: e.target.value })}
          placeholder="https://…"
          data-testid="chaine-image"
        />
        {imageRefusee ? (
          <span className="mt-1 block text-xs text-coral" data-testid="chaine-image-refus">
            {t(
              'Il faut une adresse https publique. Une adresse interne ou en http sera refusée à la publication.',
              'A public https address is required. Internal or http addresses are rejected on publish.',
            )}
          </span>
        ) : null}
      </label>

      {/* --- Le bouton Discuter ------------------------------------------------------------------- */}
      <div className="rounded-xl border border-ink-200 p-4">
        <p className="text-sm font-medium text-ink-700">{t('Bouton « Discuter »', '"Chat" button')}</p>
        <p className="mt-1 text-xs text-ink-400">
          {t(
            'Rattache un scénario : la publication portera un bouton qui ouvre une conversation et le démarre.',
            'Attach a scenario: the post carries a button that opens a chat and starts it.',
          )}
        </p>

        {phone === null ? (
          <p className="mt-3 rounded-lg bg-gold/10 px-3 py-2 text-xs text-ink-600" data-testid="chaine-sans-numero">
            {t(
              'Aucun numéro WhatsApp connecté : impossible de créer un lien tant qu’il n’y en a pas.',
              'No WhatsApp number connected: links cannot be created until there is one.',
            )}
          </p>
        ) : (
          <>
            <select
              className={`${inputCls} mt-3`}
              value={brouillon.linkId}
              onChange={(e) => onChange({ ...brouillon, linkId: e.target.value })}
              data-testid="chaine-lien"
            >
              <option value="">{t('Aucun bouton', 'No button')}</option>
              {liens.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.phrase}
                  {l.enabled === false ? t(' (éteint)', ' (off)') : ''}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setCreation((v) => !v)}
              className="mt-2 text-sm font-medium text-brand-600 hover:text-brand-700"
              data-testid="chaine-nouveau-lien"
            >
              {creation ? t('Annuler', 'Cancel') : t('Créer un nouveau lien', 'Create a new link')}
            </button>

            {creation ? (
              <CreationLien
                scenarios={scenarios}
                busy={busy}
                onCreer={async (input) => {
                  await props.onCreerLien(input);
                  setCreation(false);
                }}
              />
            ) : null}
          </>
        )}
      </div>

      {/* Pas de garde de rôle : `AppShell` renvoie déjà tout non-admin sur l'inbox avant cette page. */}
      <button
        type="button"
        onClick={() => void props.onPublier()}
        disabled={busy || !pretAPublier(brouillon)}
        className="w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        data-testid="chaine-publier"
      >
        {busy ? t('Publication…', 'Publishing…') : t('Publier sur la chaîne', 'Publish to channel')}
      </button>
    </div>
  );
}

/**
 * Créer un lien : un scénario, une phrase d'accroche.
 *
 * ⚠️ `estEnLigne` est un AVERTISSEMENT, pas une garde. La garde est côté serveur, qui refuse en 409 un
 * scénario sans version publiée, AVANT de publier : un post publié circule pour toujours, et un bouton qui
 * démarre un scénario vide ne se rattrape pas.
 */
function CreationLien({
  scenarios, busy, onCreer,
}: {
  scenarios: WorkflowSummary[];
  busy: boolean;
  onCreer: (input: { workflowId: string; phrase: string }) => Promise<void>;
}) {
  const t = useT();
  const [workflowId, setWorkflowId] = useState('');
  const [phrase, setPhrase] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const choisi = scenarios.find((s) => s.id === workflowId) ?? null;
  const horsLigne = choisi !== null && !estEnLigne(choisi);
  const pret = workflowId !== '' && phraseAcceptable(phrase);
  const reste = resteAAfficher(phrase.length, MAX_PHRASE);

  async function creer() {
    setErreur(null);
    try {
      await onCreer({ workflowId, phrase: phrase.trim() });
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Création impossible', 'Could not create'));
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-600">{t('Scénario à démarrer', 'Scenario to start')}</span>
        <select
          className={inputCls}
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          data-testid="chaine-scenario"
        >
          <option value="">{t('Choisir…', 'Choose…')}</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {horsLigne ? (
          <span className="mt-1 block text-xs text-coral" data-testid="chaine-scenario-hors-ligne">
            {t(
              'Ce scénario n’a aucune version publiée : publie-le d’abord, sinon le bouton ne démarrera rien.',
              'This scenario has no published version: publish it first, or the button will start nothing.',
            )}
          </span>
        ) : null}
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-600">
          {t('Phrase d’accroche', 'Opening phrase')}
        </span>
        <input
          className={inputCls}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder={t('Je veux en savoir plus', 'I want to know more')}
          data-testid="chaine-phrase"
        />
        <span className="mt-1 block text-xs text-ink-400">
          {t(
            'C’est le message que l’abonné enverra en appuyant sur le bouton. Court, il se lit mieux.',
            'This is the message the subscriber sends when tapping the button. Shorter reads better.',
          )}
        </span>
        {reste !== null ? (
          <span className={`mt-1 block text-xs tabular-nums ${reste < 0 ? 'text-coral' : 'text-ink-400'}`}>
            {reste < 0
              ? t(`${-reste} caractères de trop`, `${-reste} characters too many`)
              : t(`${reste} caractères restants`, `${reste} characters left`)}
          </span>
        ) : null}
      </label>

      {erreur ? <p className="text-xs text-coral" data-testid="chaine-lien-erreur">{erreur}</p> : null}

      <button
        type="button"
        onClick={() => void creer()}
        disabled={busy || !pret}
        className="rounded-lg border border-brand-500 px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50"
        data-testid="chaine-creer-lien"
      >
        {busy ? t('Création…', 'Creating…') : t('Créer le lien', 'Create link')}
      </button>
    </div>
  );
}
