'use client';

import { useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { estEnLigne, type WorkflowSummary } from '@/lib/api';
import { inputCls } from '@/lib/ui';
import { MAX_PHRASE, MAX_TEXTE_POST, type LienChaine } from '@/lib/api-chaine';
import {
  entoure, insere, MARQUEURS, type Edition, type Marqueur, type StyleBarre,
} from '@/lib/chaine-mise-en-forme';
import { SelecteurEmojis } from '@/components/SelecteurEmojis';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import {
  imageAffichable, liensAProposer, libelleLien, phraseAcceptable, pretAPublier, resteAAfficher,
  type BrouillonChaine,
} from '@/lib/chaine-apercu';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';

/** Ce que chaque style MONTRE dans la barre. Le style lui-même vit dans `MARQUEURS`, ici c'est l'habillage. */
const HABILLAGE: Record<StyleBarre, { fr: string; en: string; lettre: string; classe: string }> = {
  gras: { fr: 'Gras', en: 'Bold', lettre: 'B', classe: 'font-semibold' },
  italique: { fr: 'Italique', en: 'Italic', lettre: 'I', classe: 'italic' },
  barre: { fr: 'Barré', en: 'Strikethrough', lettre: 'S', classe: 'line-through' },
};

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
  /** L'espace, pour héberger l'image téléversée. */
  tenantId: string;
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
  const { brouillon, onChange, tenantId, liens, scenarios, phone, busy } = props;
  const [creation, setCreation] = useState(false);
  const [emojis, setEmojis] = useState(false);
  /**
   * La liste est-elle dépliée ? Un état LOCAL et volontairement non mémorisé : replier à la prochaine
   * ouverture de l'écran est le bon défaut, sinon quelqu'un qui a déplié une fois retrouverait la longue
   * liste pour toujours, ce qui annulerait la limite.
   */
  const [tousLesLiens, setTousLesLiens] = useState(false);
  const proposes = liensAProposer(liens, brouillon.linkId, tousLesLiens);
  const zoneRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Applique une transformation A LA SELECTION COURANTE, puis repose la selection.
   *
   * ⚠️ La position du curseur est REPOSEE apres le rendu (`requestAnimationFrame`) : React reecrit la valeur
   * du textarea de facon controlee, et une selection posee avant ce rendu serait ecrasee, renvoyant le
   * curseur a la fin. C'est precisement le defaut qu'on veut eviter.
   */
  function appliquer(transforme: (texte: string, debut: number, fin: number) => Edition): void {
    const zone = zoneRef.current;
    if (!zone) return;
    const r = transforme(brouillon.texte, zone.selectionStart, zone.selectionEnd);
    onChange({ ...brouillon, texte: r.texte });
    requestAnimationFrame(() => {
      zone.focus();
      zone.setSelectionRange(r.debut, r.fin);
    });
  }

  const image = brouillon.imageUrl.trim();
  const imageRefusee = image !== '' && imageAffichable(image) === null;
  // 🔴 La longueur TRIMEE, la meme que celle sur laquelle `pretAPublier` decide (et que le `.trim()` du
  // schema Zod du serveur applique). Sur la longueur brute, un texte de 4096 caracteres suivi de trois
  // espaces affichait « 3 caracteres de trop » en rouge pendant que le bouton Publier restait actif : deux
  // moities de l ecran se contredisaient.
  const reste = resteAAfficher(brouillon.texte.trim().length, MAX_TEXTE_POST);

  return (
    <div className="space-y-4" data-testid="chaine-composeur">
      {/* 🔴 UN `div`, PAS UN `label`, ET LE LIBELLÉ POINTE LA ZONE DE TEXTE PAR SON `id`. Un `label` sans
          `for` s'associe à son PREMIER descendant labelable : depuis que la barre d'outils vit à l'intérieur,
          ce n'était plus le `textarea` mais le bouton Gras. Cliquer sur le mot « Message » mettait donc du
          gras au lieu de placer le curseur, et un lecteur d'écran annonçait « Message » sur ce bouton. */}
      <div className="block">
        <label htmlFor="chaine-texte" className="mb-1 block text-sm font-medium text-ink-500">
          {t('Message', 'Message')}
        </label>
        {/* 🔴 LA BARRE AGIT SUR LA SÉLECTION, et la REPLACE ensuite. Un éditeur qui renvoie le curseur à la
            fin après chaque clic oblige à re-sélectionner pour enchaîner gras puis italique, c'est-à-dire
            exactement ce qu'on fait quand on met en forme. La logique vit dans un module pur et testé ;
            ici il ne reste que le geste sur le DOM. */}
        <div className="mb-1 flex flex-wrap items-center gap-1" data-testid="chaine-barre-outils">
          {/* 🔴 LA BARRE EST DÉRIVÉE DE `MARQUEURS`, elle n'en tient pas une copie. Deux listes à aligner à
              la main dérivent : ajouter un marqueur d'un seul côté donne soit un bouton qui écrit un
              balisage que l'aperçu ne rend pas, soit un style que rien n'insère. */}
          {(Object.entries(MARQUEURS) as [Marqueur, StyleBarre][]).map(([marqueur, style]) => (
            <button
              key={marqueur}
              type="button"
              onClick={() => appliquer((txt, d, f) => entoure(txt, d, f, marqueur))}
              title={t(HABILLAGE[style].fr, HABILLAGE[style].en)}
              aria-label={t(HABILLAGE[style].fr, HABILLAGE[style].en)}
              data-testid={`chaine-format-${style}`}
              className="rounded-controle border border-ink-300 px-2 py-1 text-xs text-ink-900 transition-colors duration-150 hover:bg-ink-50"
            >
              <span className={HABILLAGE[style].classe}>{HABILLAGE[style].lettre}</span>
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-ink-200" />
          {/* 🔴 LE sélecteur d'emojis du produit, pas un troisième. La liste (`lib/emojis.ts`) était déjà
              partagée ; la grille, elle, était recopiée dans deux composeurs qui avaient divergé. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setEmojis((v) => !v)}
              aria-label={t('Smileys', 'Emojis')}
              data-testid="chaine-emojis"
              className="rounded-controle border border-ink-300 p-1.5 text-ink-500 transition-colors duration-150 hover:bg-ink-50"
            >
              <Icone nom="smiley" />
            </button>
            {emojis && (
              <SelecteurEmojis
                ancrage="haut"
                alignement="gauche"
                onClose={() => setEmojis(false)}
                onPick={(emo) => appliquer((txt, d, f) => insere(txt, d, f, emo))}
              />
            )}
          </div>
        </div>
        <textarea
          ref={zoneRef}
          id="chaine-texte"
          className={`${inputCls} min-h-[130px]`}
          value={brouillon.texte}
          onChange={(e) => onChange({ ...brouillon, texte: e.target.value })}
          placeholder={t('Ce que tes abonnés vont lire…', 'What your subscribers will read…')}
          data-testid="chaine-texte"
        />
        {reste !== null ? (
          <span
            className={`mt-1 block text-xs tabular-nums ${reste < 0 ? 'text-danger' : 'text-ink-500'}`}
            data-testid="chaine-texte-reste"
          >
            {reste < 0
              ? t(`${-reste} caractères de trop`, `${-reste} characters too many`)
              : t(`${reste} caractères restants`, `${reste} characters left`)}
          </span>
        ) : null}
      </div>

      <div className="block">
        <span className="mb-1 block text-sm font-medium text-ink-500">
          {t('Image (facultatif)', 'Image (optional)')}
        </span>
        {/* 🔴 ON HÉBERGE L'IMAGE, ON NE L'ENVOIE PAS AU FOURNISSEUR. Julien voulait un bouton pour
            téléverser depuis son poste au lieu de coller une adresse. Le fournisseur accepte deux formes :
            `message[media_url]` (une adresse publique qu'il va CHERCHER) ou `message[media]` en multipart,
            accompagné d'un `message[media_checksum]` dont sa spec ne nomme PAS l'algorithme de hachage, et
            qui obligerait à signer autre chose que ce qu'on transmet, cassant l'invariant du client.
            La première forme suffit, et l'hébergeur existe déjà : c'est celui qui sert les visuels RCS aux
            opérateurs depuis des mois, `POST /rcs/media` puis `GET /m/<code>.jpg`. Rien de neuf : ni
            dépendance, ni migration, ni algorithme deviné. */}
        <ChampImageHebergee
          tenantId={tenantId}
          valeur={brouillon.imageUrl}
          onChange={(url) => onChange({ ...brouillon, imageUrl: url })}
          testIdPrefix="chaine"
          avertirExtension={false}
        />
        {imageRefusee ? (
          <span className="mt-1 block text-xs text-danger" data-testid="chaine-image-refus">
            {t(
              'Il faut une adresse https publique. Une adresse interne ou en http sera refusée à la publication.',
              'A public https address is required. Internal or http addresses are rejected on publish.',
            )}
          </span>
        ) : null}
      </div>

      {/* --- Le bouton Discuter ------------------------------------------------------------------- */}
      <div className="rounded-carte border border-ink-200 p-4">
        <p className="text-sm font-medium text-ink-900">{t('Bouton « Discuter »', '"Chat" button')}</p>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'Rattache un scénario : la publication portera un bouton qui ouvre une conversation et le démarre.',
            'Attach a scenario: the post carries a button that opens a chat and starts it.',
          )}
        </p>

        {phone === null ? (
          <p className="mt-3 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-ink-500" data-testid="chaine-sans-numero">
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
              {/* ⚠️ L'état allumé du lien ne s'affiche PAS ici, et c'est délibéré : publier rallume le lien
                  de toute façon (`POST /posts` appelle `allumerAutomationLien`). Marquer « éteint » à la
                  composition ferait croire que le bouton du futur post ne marchera pas, alors qu'il
                  marchera. L'état compte dans la liste des publications, où un bouton déjà parti peut
                  vraiment être mort, pas ici. */}
              {proposes.map((l) => (
                <option key={l.id} value={l.id}>{libelleLien(l, scenarios)}</option>
              ))}
            </select>

            {/* 🔴 L'ÉCHAPPATOIRE EST OBLIGATOIRE, ET C'EST CE QUI REND LA LIMITE ACCEPTABLE. Trois liens
                suffisent au geste courant (réutiliser un bouton qu'on vient de créer), mais rien ne dit
                qu'on ne veut jamais republier avec un lien de mars : le lien existe toujours, il n'a pas
                été supprimé, et une liste qui le cacherait POUR TOUJOURS obligerait à en recréer un, donc
                à fabriquer un doublon de la chose qu'on essaie de limiter. */}
            {liens.length > proposes.length && (
              <button
                type="button"
                onClick={() => setTousLesLiens(true)}
                className="mt-1.5 block text-xs font-medium text-ink-500 hover:text-ink-900"
                data-testid="chaine-tous-les-liens"
              >
                {t(`Voir tous les liens (${liens.length})`, `Show all links (${liens.length})`)}
              </button>
            )}

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
      <Bouton enCours={busy}
        type="button"
        onClick={() => void props.onPublier()}
        disabled={busy || !pretAPublier(brouillon)}
        className="w-full"
        data-testid="chaine-publier"
      >
        {busy ? t('Publication…', 'Publishing…') : t('Publier sur la chaîne', 'Publish to channel')}
      </Bouton>
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
  // Meme raison que dans le composeur : `phraseAcceptable` decide sur la longueur trimee.
  const reste = resteAAfficher(phrase.trim().length, MAX_PHRASE);

  async function creer() {
    setErreur(null);
    try {
      await onCreer({ workflowId, phrase: phrase.trim() });
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Création impossible', 'Could not create'));
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-carte bg-ink-50 p-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-500">{t('Scénario à démarrer', 'Scenario to start')}</span>
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
          <span className="mt-1 block text-xs text-danger" data-testid="chaine-scenario-hors-ligne">
            {t(
              'Ce scénario n’a aucune version publiée : publie-le d’abord, sinon le bouton ne démarrera rien.',
              'This scenario has no published version: publish it first, or the button will start nothing.',
            )}
          </span>
        ) : null}
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-500">
          {t('Phrase d’accroche', 'Opening phrase')}
        </span>
        <input
          className={inputCls}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder={t('Je veux en savoir plus', 'I want to know more')}
          data-testid="chaine-phrase"
        />
        <span className="mt-1 block text-xs text-ink-500">
          {t(
            'C’est le message que l’abonné enverra en appuyant sur le bouton. Court, il se lit mieux.',
            'This is the message the subscriber sends when tapping the button. Shorter reads better.',
          )}
        </span>
        {reste !== null ? (
          <span className={`mt-1 block text-xs tabular-nums ${reste < 0 ? 'text-danger' : 'text-ink-500'}`}>
            {reste < 0
              ? t(`${-reste} caractères de trop`, `${-reste} characters too many`)
              : t(`${reste} caractères restants`, `${reste} characters left`)}
          </span>
        ) : null}
      </label>

      {erreur ? <p className="text-xs text-danger" data-testid="chaine-lien-erreur">{erreur}</p> : null}

      <Bouton variante="secondaire" enCours={busy}
        type="button"
        onClick={() => void creer()}
        disabled={busy || !pret}
        data-testid="chaine-creer-lien"
      >
        {busy ? t('Création…', 'Creating…') : t('Créer le lien', 'Create link')}
      </Bouton>
    </div>
  );
}
