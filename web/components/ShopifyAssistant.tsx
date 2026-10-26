'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Modale } from '@/components/Modale';
import { Bouton } from '@/components/Bouton';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { listTemplates } from '@/lib/api';
import { preparerMessageShopify, reglerMessageShopify, type EtatShopifyVue } from '@/lib/api-shopify';
import {
  DELAI_PANIER_DEFAUT, DELAI_PANIER_MAX, DELAI_PANIER_MIN, DELAIS_PROPOSES, DONNEES_PAR_EVENEMENT, LIBELLES_EVENEMENTS, PIED_STOP,
  langueDuPied, prenomDeSecours, type EvenementShopify,
} from '@/lib/partage/shopify-messages';
import {
  apercuAffiche, delaiEnClair, etatDuMessage, repere, texteDuModele, textePropose, versTexteServeur,
} from '@/lib/shopify-assistant';

/**
 * L'ASSISTANT D'UN MESSAGE SHOPIFY (conception 2026-10-22, maquette validée) : le message, le délai (relance
 * seulement), puis « Envoyer à Meta et activer dès l'approbation ». Le même pour les trois messages ; le serveur
 * (`src/shopify/preparation.ts`) tient chaque règle, l'écran ne fait que les annoncer plus tôt. Aucune question du
 * consentement (décision de Julien du 2026-10-26) : il est la responsabilité du marchand.
 *
 * ⚠️ Modifier un message ACTIF ne l'arrête pas : l'ancien part jusqu'à l'approbation du nouveau. Si seul le délai de la
 * relance change, rien ne repasse par Meta (`reglerMessageShopify`).
 */

type Etape = 'message' | 'delai';

export function ShopifyAssistant({ tenantId, evenement, vue, onClose, onFini }: {
  tenantId: string;
  evenement: EvenementShopify;
  vue: EtatShopifyVue;
  onClose: () => void;
  /** Le geste a réussi : la carte se recharge et affiche ce texte. */
  onFini: (bilan: string) => Promise<void>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const relance = evenement === 'checkout_abandoned';
  const etapes: Etape[] = relance ? ['message', 'delai'] : ['message'];
  const etat = etatDuMessage(vue, evenement);
  // Le texte de départ : l'attente la plus récente, sinon le message branché, sinon le texte proposé.
  const attente = vue.attentes.find((a) => a.evenement === evenement) ?? null;
  const source = attente ?? vue.messages.find((m) => m.evenement === evenement) ?? null;
  const modeleSource = source?.modele ?? null;
  const langueSource = source?.langue ?? null;
  const variablesSource = source?.variables.join(',') ?? '';

  const [etape, setEtape] = useState<Etape>('message');
  const [langue, setLangue] = useState<string>(source?.langue || locale);
  const [texte, setTexte] = useState(() => textePropose(evenement, langueDuPied(source?.langue || locale), locale));
  const [texteModele, setTexteModele] = useState<string | null>(null);
  const touche = useRef(false);
  const zone = useRef<HTMLTextAreaElement>(null);
  const delaiInitial = vue.boutique?.delaiPanierMinutes ?? DELAI_PANIER_DEFAUT;
  const [delai, setDelai] = useState(delaiInitial);
  const [autre, setAutre] = useState(!DELAIS_PROPOSES.includes(delaiInitial));
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // Le texte du modèle en place, relu chez Meta : « Modifier » part de ce que le client reçoit aujourd'hui.
  useEffect(() => {
    if (modeleSource === null) return;
    let vivant = true;
    listTemplates(tenantId).then(({ templates }) => {
      const m = templates.find((x) => x.name === modeleSource && x.language === langueSource);
      if (!vivant || !m?.body) return;
      const lu = texteDuModele(m.body, variablesSource.split(','), locale);
      setTexteModele(lu);
      if (!touche.current) setTexte(lu);
    }).catch(() => { /* le texte proposé reste : rien n'est perdu */ });
    return () => { vivant = false; };
  }, [tenantId, modeleSource, langueSource, variablesSource, locale]);

  const conversion = versTexteServeur(texte, evenement);
  const langues = Array.from(new Set(['fr', 'en', langue]));
  const index = etapes.indexOf(etape);
  const derniere = index === etapes.length - 1;
  const delaiValide = Number.isInteger(delai) && delai >= DELAI_PANIER_MIN && delai <= DELAI_PANIER_MAX;
  const inchange = source !== null && texteModele !== null && texte.trim() === texteModele.trim() && langue === source.langue;
  // Rien de neuf pour Meta : même texte, même langue, sur le message qui part déjà (et non sur une version en attente,
  // dont le texte n'est pas celui qui part : relecture du lot 3).
  const sansMeta = attente === null && etat === 'actif' && inchange;
  // Le texte qui attend déjà Meta, renvoyé tel quel, créerait un doublon chez Meta et remettrait l'attente à zéro.
  const dejaChezMeta = attente !== null && inchange;
  // Un message de commande n'a que son texte : inchangé, il n'y a rien à enregistrer (la relance garde son délai).
  const rienAEnregistrer = sansMeta && !relance;

  const inserer = (r: string): void => {
    touche.current = true;
    const el = zone.current;
    const debut = el?.selectionStart ?? texte.length;
    const fin = el?.selectionEnd ?? texte.length;
    setTexte(texte.slice(0, debut) + r + texte.slice(fin));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(debut + r.length, debut + r.length); });
  };

  const changerLangue = (l: string): void => {
    setLangue(l);
    if (!touche.current) setTexte(textePropose(evenement, langueDuPied(l), locale));
  };

  /** Ce qui retient l'étape affichée, dit au marchand ; `null` : rien. */
  const erreurDeLEtape = (): string | null => {
    if (etape === 'message' && conversion.ok && (/^\s*\{\{/.test(conversion.texte) || /\}\}\s*$/.test(conversion.texte))) {
      // Meta refuse un corps qui commence ou finit par une donnée : dit ici, avec les repères du marchand.
      return t('Le message ne peut ni commencer ni finir par une donnée : ajoutez quelques mots avant ou après.', 'The message can neither start nor end with a value: add a few words before or after.');
    }
    if (etape === 'message' && !conversion.ok) {
      return [
        ...(conversion.inconnus.length > 0 ? [t(`Donnée inconnue : ${conversion.inconnus.join(', ')}.`, `Unknown value: ${conversion.inconnus.join(', ')}.`)] : []),
        ...(conversion.horsEvenement.length > 0
          ? [t(`Ce message ne sait pas remplir : ${conversion.horsEvenement.join(', ')}.`, `This message cannot fill: ${conversion.horsEvenement.join(', ')}.`)]
          : []),
      ].join(' ');
    }
    if (etape === 'delai' && !delaiValide) return t(`Un délai de ${DELAI_PANIER_MIN} min à 72 h.`, `A delay from ${DELAI_PANIER_MIN} min to 72 h.`);
    return null;
  };

  const suivant = (): void => {
    const raison = erreurDeLEtape();
    setErreur(raison);
    if (raison === null) setEtape(etapes[index + 1]!);
  };

  const envoyer = async (): Promise<void> => {
    // La dernière étape se vérifie ici : le texte d'un message de commande, qui n'a que lui, ou le délai de la relance.
    const raison = erreurDeLEtape();
    if (raison !== null) {
      setErreur(raison);
      return;
    }
    if (!conversion.ok) return;
    setEnCours(true);
    setErreur(null);
    try {
      let bilan: string;
      if (sansMeta) {
        await reglerMessageShopify(tenantId, evenement, relance ? { delaiMinutes: delai } : {});
        bilan = t('Enregistré : le changement s’applique tout de suite.', 'Saved: the change applies right away.');
      } else {
        const r = await preparerMessageShopify(tenantId, {
          evenement, texte: conversion.texte, langue, ...(relance ? { delaiMinutes: delai } : {}),
        });
        bilan = r.etat === 'actif'
          ? t('Actif : Meta a déjà approuvé le message, vos clients le reçoivent dès maintenant.', 'Active: Meta has already approved the message, your customers get it from now on.')
          : t(
            'Envoyé à Meta. Le message s’activera tout seul à l’approbation, en général en quelques minutes, et un e-mail vous préviendra.',
            'Sent to Meta. The message will switch on by itself once approved, usually within minutes, and an email will let you know.',
          );
      }
      await onFini(bilan);
    } catch (e: unknown) {
      setErreur(e instanceof Error ? e.message : t('Envoi impossible', 'Unable to send'));
    } finally {
      setEnCours(false);
    }
  };

  const titre = t(...LIBELLES_EVENEMENTS[evenement]);
  const libelleEtape: Record<Etape, string> = {
    message: t('Le message', 'The message'),
    delai: t('Le délai', 'The delay'),
  };

  return (
    <Modale
      titre={titre}
      // Un message de commande n'a qu'une étape : « Étape 1 sur 1 » ne dirait rien.
      sousTitre={etapes.length > 1
        ? t(`Étape ${index + 1} sur ${etapes.length} : ${libelleEtape[etape]}`, `Step ${index + 1} of ${etapes.length}: ${libelleEtape[etape]}`)
        : undefined}
      taille="large"
      testId="shopify-assistant"
      onClose={onClose}
      pied={(
        <>
          {index > 0 && <Bouton type="button" variante="discret" onClick={() => { setErreur(null); setEtape(etapes[index - 1]!); }}>{t('Retour', 'Back')}</Bouton>}
          {derniere ? (
            <Bouton
              type="button" onClick={() => void envoyer()} enCours={enCours}
              disabled={enCours || dejaChezMeta || rienAEnregistrer} data-testid="shopify-assistant-envoyer"
            >
              {sansMeta ? t('Enregistrer', 'Save') : t('Envoyer à Meta et activer dès l’approbation', 'Send to Meta and switch on once approved')}
            </Bouton>
          ) : (
            <Bouton type="button" onClick={suivant} data-testid="shopify-assistant-suivant">{t('Suivant', 'Next')}</Bouton>
          )}
        </>
      )}
    >
      <div className="grid gap-5 md:grid-cols-[1fr_18rem]">
        <div className="space-y-3 text-sm">
          {etape === 'message' && (
            <>
              {etat === 'actif_nouvelle_version' && (
                <p className="text-ink-500">{t('Une nouvelle version attend Meta ; l’actuelle part en attendant.', 'A new version is waiting for Meta; the current one goes out meanwhile.')}</p>
              )}
              <label className="block text-ink-900">
                {t('Le texte que vos clients recevront', 'The text your customers will get')}
                <textarea
                  ref={zone} rows={6} data-testid="shopify-assistant-texte" value={texte}
                  onChange={(e) => { touche.current = true; setTexte(e.target.value); }} className={`${inputCls} mt-1`}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink-500">{t('Insérer :', 'Insert:')}</span>
                {DONNEES_PAR_EVENEMENT[evenement].map((d) => (
                  <button
                    key={d} type="button" onClick={() => inserer(repere(d, locale))} data-testid={`shopify-inserer-${d}`}
                    className="rounded-controle bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-200"
                  >
                    {repere(d, locale)}
                  </button>
                ))}
              </div>
              <label className="block text-ink-900">
                {t('Langue du message', 'Message language')}
                <select value={langue} onChange={(e) => changerLangue(e.target.value)} className={`${inputCls} mt-1`} data-testid="shopify-assistant-langue">
                  {langues.map((l) => <option key={l} value={l}>{l === 'fr' ? 'Français' : l === 'en' ? 'English' : l}</option>)}
                </select>
              </label>
              <p className="text-ink-500" data-testid="shopify-assistant-nouveau-modele">
                {source === null
                  ? t('Le texte devient un modèle chez Meta, validé en général en quelques minutes.', 'The text becomes a template at Meta, usually approved within minutes.')
                  : t(
                    'Un nouveau texte crée un nouveau modèle chez Meta, validé en général en quelques minutes : le message actuel part en attendant, et l’ancien modèle, s’il a été créé ici, est ensuite supprimé.',
                    'A new text creates a new template at Meta, usually approved within minutes: the current message goes out meanwhile, and the old template, if it was created here, is then deleted.',
                  )}
                {source !== null && relance && ` ${t('Changer seulement le délai s’applique tout de suite.', 'Changing only the delay applies right away.')}`}
              </p>
              {conversion.ok && conversion.texte.includes('{{first_name}}') && (
                <p className="text-ink-500" data-testid="shopify-assistant-prenom-secours">
                  {t(
                    `Le prénom est facultatif chez Shopify : quand le client ne l’a pas donné, le message dit « ${prenomDeSecours(langue)} » à sa place.`,
                    `The first name is optional on Shopify: when the customer did not give it, the message says “${prenomDeSecours(langue)}” instead.`,
                  )}
                </p>
              )}
              {relance && (
                <p className="text-ink-500">
                  {t(
                    'La mention « Répondez STOP pour ne plus recevoir ces messages » est ajoutée en bas du message : un client qui répond STOP ne reçoit plus rien.',
                    'The line “Reply STOP to stop these messages” is added at the bottom: a customer who replies STOP gets nothing more.',
                  )}
                </p>
              )}
            </>
          )}
          {etape === 'delai' && (
            <>
              <p className="text-ink-900">{t('La relance part après la dernière modification du panier, si aucune commande n’en est née.', 'The reminder goes out after the last change to the checkout, if no order came of it.')}</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('Délai', 'Delay')}>
                {DELAIS_PROPOSES.map((m) => (
                  <Bouton
                    key={m} type="button" taille="petite" variante={!autre && delai === m ? 'principal' : 'secondaire'}
                    role="radio" aria-checked={!autre && delai === m} onClick={() => { setAutre(false); setDelai(m); }} data-testid={`shopify-delai-${m}`}
                  >
                    {delaiEnClair(m)}{m === DELAI_PANIER_DEFAUT ? ` (${t('conseillé', 'recommended')})` : ''}
                  </Bouton>
                ))}
                <Bouton type="button" taille="petite" variante={autre ? 'principal' : 'secondaire'} role="radio" aria-checked={autre} onClick={() => setAutre(true)} data-testid="shopify-delai-autre">
                  {t('Autre', 'Other')}
                </Bouton>
              </div>
              {autre && (
                <label className="block text-ink-900">
                  {t('En minutes, de 15 à 4 320 (72 h)', 'In minutes, from 15 to 4,320 (72 h)')}
                  <input
                    type="number" min={DELAI_PANIER_MIN} max={DELAI_PANIER_MAX} value={delai} data-testid="shopify-delai-minutes"
                    onChange={(e) => setDelai(Number(e.target.value))} className={`${inputCls} mt-1`}
                  />
                </label>
              )}
              {delaiValide && <p className="text-ink-500">{t(`Relance ${delaiEnClair(delai)} après la dernière modification.`, `Reminder ${delaiEnClair(delai)} after the last change.`)}</p>}
            </>
          )}
          {derniere && dejaChezMeta && (
            <p className="text-ink-500" data-testid="shopify-assistant-deja">
              {t('Ce texte attend déjà l’approbation de Meta : rien à renvoyer. Modifiez-le pour en préparer une autre version.', 'This text is already awaiting Meta’s approval: nothing to resend. Edit it to prepare another version.')}
            </p>
          )}
          {rienAEnregistrer && (
            <p className="text-ink-500" data-testid="shopify-assistant-inchange">
              {t('Ce texte est déjà celui que vos clients reçoivent : rien à enregistrer. Modifiez-le pour en préparer une autre version.', 'This text is already the one your customers get: nothing to save. Edit it to prepare another version.')}
            </p>
          )}
          {erreur && <p className="text-danger" data-testid="shopify-assistant-erreur">{erreur}</p>}
        </div>
        <div>
          <WhatsAppPreview
            body={apercuAffiche(texte)} examples={[]} buttons={[]} hideNote
            {...(relance ? { footer: PIED_STOP[langueDuPied(langue)] } : {})}
          />
          <p className="mt-2 text-xs text-ink-500">{t('Les données de la commande y sont remplacées par des valeurs d’exemple.', 'The order data is replaced here by sample values.')}</p>
        </div>
      </div>
    </Modale>
  );
}
