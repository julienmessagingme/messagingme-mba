'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Modale } from '@/components/Modale';
import { Bouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { listTemplates } from '@/lib/api';
import { preparerMessageShopify, reglerMessageShopify, type EtatShopifyVue } from '@/lib/api-shopify';
import {
  DELAI_PANIER_DEFAUT, DELAI_PANIER_MAX, DELAI_PANIER_MIN, DELAIS_PROPOSES, DONNEES_PAR_EVENEMENT, LIBELLES_EVENEMENTS, PIED_STOP,
  langueDuPied, type EvenementShopify,
} from '@/lib/partage/shopify-messages';
import {
  apercuAffiche, delaiEnClair, etatDuMessage, repere, texteDuModele, textePropose, versTexteServeur,
} from '@/lib/shopify-assistant';

/**
 * L'ASSISTANT D'UN MESSAGE SHOPIFY (conception 2026-10-22, maquette validée) : le message, le délai (relance
 * seulement), le consentement, puis « Envoyer à Meta et activer dès l'approbation ». Le même pour les trois messages ;
 * le serveur (`src/shopify/preparation.ts`) tient chaque règle, l'écran ne fait que les annoncer plus tôt.
 *
 * ⚠️ Modifier un message ACTIF ne l'arrête pas : l'ancien part jusqu'à l'approbation du nouveau. Si seuls le délai ou la
 * case changent, rien ne repasse par Meta (`reglerMessageShopify`).
 */

type Etape = 'message' | 'delai' | 'consentement';

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
  const confirmer = useConfirmation();
  const relance = evenement === 'checkout_abandoned';
  const etapes: Etape[] = relance ? ['message', 'delai', 'consentement'] : ['message', 'consentement'];
  const etat = etatDuMessage(vue, evenement);
  // Le texte de départ : l'attente la plus récente, sinon le message branché, sinon le texte proposé.
  const attente = vue.attentes.find((a) => a.evenement === evenement) ?? null;
  const source = attente ?? vue.messages.find((m) => m.evenement === evenement) ?? null;
  const consentementLe = vue.boutique?.consentementLe ?? null;
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
  const [consentement, setConsentement] = useState(consentementLe !== null);
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
  const sansMeta = attente === null && (etat === 'actif' || etat === 'en_pause') && inchange;
  // Le texte qui attend déjà Meta, renvoyé tel quel, créerait un doublon chez Meta et remettrait l'attente à zéro.
  const dejaChezMeta = attente !== null && inchange;

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

  const suivant = (): void => {
    setErreur(null);
    if (etape === 'message' && conversion.ok && (/^\s*\{\{/.test(conversion.texte) || /\}\}\s*$/.test(conversion.texte))) {
      // Meta refuse un corps qui commence ou finit par une donnée : dit ici, avec les repères du marchand.
      setErreur(t('Le message ne peut ni commencer ni finir par une donnée : ajoutez quelques mots avant ou après.', 'The message can neither start nor end with a value: add a few words before or after.'));
      return;
    }
    if (etape === 'message' && !conversion.ok) {
      const parts = [
        ...(conversion.inconnus.length > 0 ? [t(`Donnée inconnue : ${conversion.inconnus.join(', ')}.`, `Unknown value: ${conversion.inconnus.join(', ')}.`)] : []),
        ...(conversion.horsEvenement.length > 0
          ? [t(`Ce message ne sait pas remplir : ${conversion.horsEvenement.join(', ')}.`, `This message cannot fill: ${conversion.horsEvenement.join(', ')}.`)]
          : []),
      ];
      setErreur(parts.join(' '));
      return;
    }
    if (etape === 'delai' && !delaiValide) {
      setErreur(t(`Un délai de ${DELAI_PANIER_MIN} min à 72 h.`, `A delay from ${DELAI_PANIER_MIN} min to 72 h.`));
      return;
    }
    setEtape(etapes[index + 1]!);
  };

  const envoyer = async (): Promise<void> => {
    if (!conversion.ok) return;
    const retrait = !relance && consentementLe !== null && !consentement;
    if (retrait && !(await confirmer({
      titre: t('Retirer votre affirmation', 'Withdraw your statement'),
      message: t(
        'Elle vaut pour toute la boutique : la relance de panier s’arrêtera, puisqu’elle ne part qu’à des clients qui ont accepté vos messages.',
        'It applies to the whole store: the abandoned checkout reminder will stop, since it only goes to customers who accepted your messages.',
      ),
      confirmer: t('Retirer', 'Withdraw'),
    }))) return;
    setEnCours(true);
    setErreur(null);
    try {
      const affirme = consentement && consentementLe === null ? { consentementAffirme: true } : {};
      let bilan: string;
      if (sansMeta) {
        await reglerMessageShopify(tenantId, evenement, { ...(relance ? { delaiMinutes: delai } : {}), ...affirme });
        bilan = t('Enregistré : le changement s’applique tout de suite.', 'Saved: the change applies right away.');
      } else {
        const r = await preparerMessageShopify(tenantId, {
          evenement, texte: conversion.texte, langue, ...(relance ? { delaiMinutes: delai } : {}), ...affirme,
        });
        bilan = r.etat === 'actif'
          ? t('Actif : Meta a déjà approuvé le message, vos clients le reçoivent dès maintenant.', 'Active: Meta has already approved the message, your customers get it from now on.')
          : t(
            'Envoyé à Meta. Le message s’activera tout seul à l’approbation, en général en quelques minutes, et un e-mail vous préviendra.',
            'Sent to Meta. The message will switch on by itself once approved, usually within minutes, and an email will let you know.',
          );
        // Une relance en pause qu'on réaffirme repart tout de suite, avec son texte actuel.
        if (r.etat !== 'actif' && etat === 'en_pause' && 'consentementAffirme' in affirme) {
          bilan += ` ${t('La relance actuelle repart dès maintenant ; la nouvelle version la remplacera à l’approbation.', 'The current reminder goes out again right away; the new version will replace it once approved.')}`;
        }
      }
      if (retrait) {
        const r = await reglerMessageShopify(tenantId, evenement, { consentementAffirme: false });
        if (r.relanceArretee) bilan += ` ${t('Affirmation retirée : la relance de panier est en pause.', 'Statement withdrawn: the checkout reminder is paused.')}`;
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
    consentement: t('Le consentement', 'Consent'),
  };

  return (
    <Modale
      titre={titre}
      sousTitre={t(`Étape ${index + 1} sur ${etapes.length} : ${libelleEtape[etape]}`, `Step ${index + 1} of ${etapes.length}: ${libelleEtape[etape]}`)}
      taille="large"
      testId="shopify-assistant"
      onClose={onClose}
      pied={(
        <>
          {index > 0 && <Bouton type="button" variante="discret" onClick={() => { setErreur(null); setEtape(etapes[index - 1]!); }}>{t('Retour', 'Back')}</Bouton>}
          {derniere ? (
            <Bouton
              type="button" onClick={() => void envoyer()} enCours={enCours}
              disabled={enCours || !conversion.ok || (relance && !consentement) || dejaChezMeta} data-testid="shopify-assistant-envoyer"
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
          {etape === 'consentement' && (
            <>
              <label className="flex items-start gap-2 text-ink-900">
                <input
                  type="checkbox" checked={consentement} onChange={(e) => setConsentement(e.target.checked)} data-testid="shopify-assistant-consentement"
                  className="mt-0.5 h-4 w-4 rounded-controle border-ink-300"
                />
                <span>
                  {t('J’affirme que mes clients ont accepté de recevoir mes messages WhatsApp.', 'I confirm that my customers agreed to receive my WhatsApp messages.')}
                  <span className="block text-xs text-ink-500">
                    {consentementLe
                      ? t(`Affirmé le ${new Date(consentementLe).toLocaleDateString()}, pour toute la boutique.`, `Confirmed on ${new Date(consentementLe).toLocaleDateString()}, for the whole store.`)
                      : t('Cette affirmation vaut pour toute la boutique.', 'This statement applies to the whole store.')}
                  </span>
                </span>
              </label>
              <p className="text-ink-500">
                {relance
                  ? t('Obligatoire pour la relance : c’est un message marketing.', 'Required for the reminder: it is a marketing message.')
                  : t('Facultatif pour un message de commande, qui est un message de service.', 'Optional for an order message, which is a service message.')}
              </p>
            </>
          )}
          {derniere && dejaChezMeta && (
            <p className="text-ink-500" data-testid="shopify-assistant-deja">
              {t('Ce texte attend déjà l’approbation de Meta : rien à renvoyer. Modifiez-le pour en préparer une autre version.', 'This text is already awaiting Meta’s approval: nothing to resend. Edit it to prepare another version.')}
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
