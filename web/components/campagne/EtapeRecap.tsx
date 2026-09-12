'use client';

import { useEffect, useMemo, useState } from 'react';
import { countContacts, createCampaign, runCampaign } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { DEBIT_ETALE_PAR_MINUTE, type EtageAssistant } from '@/lib/campagne-chaine';
import {
  LIBELLE_CANAL, champEmailEffectif, filtresDeLAudience, repartitionPrevue,
  type MesuresAudience,
} from '@/lib/campagne-repartition';
import { entreeDeCreation, problemeAvantLancement } from '@/lib/campagne-creation';
import type {
  EtapeAssistant, EtatCampagne, ReferencesContenu,
} from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 5 : LE RÉCAPITULATIF, QUI N'EST PAS UN RÉSUMÉ.
 *
 * 🔴 IL RACHÈTE L'ORDRE DES ÉTAPES. L'audience est demandée APRÈS le contenu : l'opérateur a donc réglé
 * ses étages sans savoir combien de monde chacun couvre. Un écran qui se contenterait de relire ses
 * choix ne lui apprendrait rien qu'il ne vienne de taper. Celui-ci porte la RÉPARTITION PRÉVUE, c'est-à-dire
 * la seule information qu'il n'a vue nulle part.
 *
 * 🔴 IL NE PRÉDIT PAS 131049, ET NE DIT RIEN À CE SUJET. Le plafond marketing de Meta est par
 * UTILISATEUR et vit chez Meta : aucun compte de notre base ne l'approche. Annoncer un chiffre à ce
 * sujet serait faux ; ne rien dire est la seule option honnête.
 *
 * ⚠️ LE TABLEAU EST LE SEUL ENDROIT DE L'ASSISTANT OÙ LA LARGEUR EST COMMANDÉE PAR UNE DONNÉE. Un compte
 * à sept chiffres (1 000 000 de contacts) est le pire cas d'une cellule. Il scrolle donc DANS SON PROPRE
 * conteneur (`overflow-x-auto`), et la page ne scrolle jamais de côté : c'est la différence entre une
 * page utilisable sur un 13 pouces et une page coupée.
 */
export function EtapeRecap({
  tenantId,
  etat,
  chaine,
  references,
  aller,
  onCree,
}: {
  tenantId: string;
  etat: EtatCampagne;
  chaine: EtageAssistant[];
  references: ReferencesContenu;
  /** Revenir à une étape, sans quitter l'assistant ni perdre l'état. */
  aller: (e: EtapeAssistant) => void;
  onCree?: (campaignId: string) => void;
}) {
  const mesures = useMesuresAudience(tenantId, etat, chaine, references.userFields);
  const lignes = useMemo(
    () => repartitionPrevue(chaine, mesures ?? { retenus: 0, connusInjoignables: null, sansAdresse: null }, (n) => fmtNum(n, 'fr')),
    [chaine, mesures],
  );

  const numero = references.numeros[0]?.id ?? '';
  const agentRcs = references.agentsRcs[0]?.agentId ?? null;
  const contexte = {
    phoneNumberId: numero,
    rcsAgentId: agentRcs,
    filtres: filtresDeLAudience(etat.audience),
    // ⚠️ LE MÊME POINT DE PASSAGE que le comptage et que le sélecteur de l'étape Contenu
    // (`champEmailEffectif`) : trois lectures du même réglage, une seule règle pour le résoudre.
    champEmail: champEmailDeLaChaine(etat, chaine, references.userFields),
  };
  const probleme = problemeAvantLancement(etat, chaine, contexte);

  const [envoi, setEnvoi] = useState<'repos' | 'en_cours' | 'fait'>('repos');
  const [erreur, setErreur] = useState<string | null>(null);

  const lancer = async (): Promise<void> => {
    setErreur(null);
    setEnvoi('en_cours');
    try {
      const cree = await createCampaign(tenantId, entreeDeCreation(etat, chaine, contexte));
      // ⚠️ LE LANCEMENT EST UN SECOND APPEL, ET SON ÉCHEC NE DÉTRUIT PAS LA CAMPAGNE : elle reste en
      // brouillon, avec ses destinataires calculés, et se lance depuis la liste. Annoncer un échec global
      // ferait croire qu'il n'y a rien à reprendre, et l'opérateur la recréerait en double.
      await runCampaign(cree.campaignId);
      setEnvoi('fait');
      onCree?.(cree.campaignId);
    } catch (err) {
      setEnvoi('repos');
      setErreur(err instanceof Error ? err.message : 'Le lancement a échoué.');
    }
  };

  return (
    <section data-testid="etape-recap" className="w-full">
      <h2 className="text-lg font-semibold text-ink-800">Récapitulatif</h2>

      <p className="mt-3 text-sm text-ink-700">
        {/*
          ⚠️ UN VRAI LIEN, PAS UN BOUTON DÉGUISÉ. Il porte l'adresse de l'étape (`?etape=audience`), donc
          il s'ouvre dans un onglet ou se copie ; le clic ordinaire, lui, revient en arrière SANS perdre
          l'état de l'assistant, qui vit en mémoire.
        */}
        <a
          href="?etape=audience"
          onClick={(e) => { e.preventDefault(); aller('audience'); }}
          data-testid="lien-audience"
          className="font-semibold text-brand-600 underline decoration-brand-200 underline-offset-2"
        >
          {mesures === null ? '...' : fmtNum(mesures.retenus, 'fr')} contacts retenus
        </a>
        {' '}
        <span className="text-ink-500">
          ({etat.audience.mode === 'tous' ? 'tous les contacts' : `tags : ${etat.audience.tags.join(', ') || 'aucun'}`})
        </span>
      </p>

      <div
        data-testid="repartition"
        className="mt-4 w-full overflow-x-auto rounded-xl border border-ink-200"
      >
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
              <th className="px-4 py-2 font-medium">Étage</th>
              <th className="px-4 py-2 font-medium">Canal</th>
              <th className="px-4 py-2 text-right font-medium">Contacts</th>
              <th className="px-4 py-2 font-medium">Ce qui est prévu</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => (
              <tr key={l.rang} className="border-b border-ink-50 last:border-0" data-testid={`repartition-${l.rang}`}>
                <td className="px-4 py-2 text-ink-500">{l.rang}</td>
                <td className="px-4 py-2 font-medium text-ink-800">{LIBELLE_CANAL[l.canal]}</td>
                {/* ⚠️ `tabular-nums` + `whitespace-nowrap` : un compte à sept chiffres ne doit ni se couper
                    en deux lignes ni faire danser la colonne d'un rafraîchissement à l'autre. C'est la
                    cellule dont la largeur est commandée par la donnée, d'où le scroll du conteneur. */}
                <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-ink-800">
                  {l.nombre === null ? '—' : fmtNum(l.nombre, 'fr')}
                </td>
                <td className="px-4 py-2 text-ink-600">{l.texte}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BlocCout etat={etat} retenus={mesures?.retenus ?? null} aller={aller} />

      {probleme && (
        <p className="mt-4 rounded-lg bg-gold/10 px-3 py-2 text-sm text-ink-700" data-testid="recap-probleme">{probleme}</p>
      )}
      {erreur && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="recap-erreur">{erreur}</p>
      )}
      {envoi === 'fait' && (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="recap-lancee">
          La campagne est lancée. Suivez-la depuis la liste des campagnes.
        </p>
      )}

      <div className="mt-4">
        <button
          type="button"
          data-testid="bouton-lancer"
          disabled={probleme !== null || envoi !== 'repos'}
          onClick={() => { void lancer(); }}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {envoi === 'en_cours' ? 'Lancement...' : 'Lancer la campagne'}
        </button>
      </div>
    </section>
  );
}

/**
 * CE QUE LA CAMPAGNE COÛTE, dit avec ce qu'on sait et rien de plus.
 *
 * 🔴 AUCUN PRIX EN EUROS, ET CE N'EST PAS UN MANQUE D'AMBITION. Le tarif d'un message vient de Meta
 * APRÈS l'envoi (`pricing_analytics`, avec sa devise) ; rien avant le lancement ne donne un prix unitaire
 * pour ce numéro, cette catégorie et ce pays. Un montant affiché ici serait inventé, et il serait cru
 * parce qu'il est à côté du bouton qui envoie.
 *
 * ⚠️ CE QUI SE DIT HONNÊTEMENT : le VOLUME facturable (un message par contact retenu, par étage tenté) et
 * la DURÉE, qui découle du débit choisi à l'étape Canal.
 */
function BlocCout({
  etat, retenus, aller,
}: { etat: EtatCampagne; retenus: number | null; aller: (e: EtapeAssistant) => void }) {
  const debit = etat.cadence === 'etale' ? DEBIT_ETALE_PAR_MINUTE : 60;
  const minutes = retenus === null ? null : Math.max(1, Math.ceil(retenus / debit));
  return (
    <div className="mt-4 w-full rounded-xl border border-ink-200 p-4" data-testid="bloc-cout">
      <h3 className="text-sm font-medium text-ink-700">Volume et durée</h3>
      <p className="mt-2 text-sm text-ink-600">
        {retenus === null
          ? 'Le nombre de contacts retenus n’a pas pu être lu : le volume et la durée restent inconnus.'
          : <>Jusqu&apos;à <b>{fmtNum(retenus, 'fr')}</b> messages facturables au premier étage, plus un message par bascule.</>}
      </p>
      <p className="mt-1 text-sm text-ink-600">
        {etat.cadence === 'ouvrees'
          ? "Envoi pendant les heures d'ouverture de l'espace uniquement : la durée dépend de vos créneaux."
          : minutes === null
            ? 'Durée inconnue.'
            : <>Environ <b>{fmtNum(minutes, 'fr')}</b> min d&apos;envoi à {fmtNum(debit, 'fr')} messages/min.</>}
        {' '}
        <a
          href="?etape=canal"
          onClick={(e) => { e.preventDefault(); aller('canal'); }}
          className="text-brand-600 underline decoration-brand-200 underline-offset-2"
        >
          Changer la cadence
        </a>
      </p>
      <p className="mt-2 text-xs text-ink-400">
        Le prix d&apos;un message dépend du pays et de la catégorie, et n&apos;est connu qu&apos;après
        l&apos;envoi : il est visible dans Analytique.
      </p>
    </div>
  );
}

/**
 * LES TROIS COMPTES QUE LA BASE SAIT RENDRE, en trois requêtes BORNÉES.
 *
 * 🔴 TROIS COMPTES, JAMAIS UNE LISTE. Rapatrier les contacts pour les compter dans le navigateur est
 * exactement ce que l'audit du 2026-09-02 a fermé : « tout sélectionner » ramenait jusqu'à 100 000
 * identifiants et la création échouait vers 25 000 sur le plafond de 1 Mo du corps de requête.
 *
 * ⚠️ CHACUN POUR LUI-MÊME, JAMAIS UN `Promise.all` TOUT-OU-RIEN : si le compte des injoignables tombe,
 * le total doit rester affiché. C'est `null` qui porte l'échec, et `null` veut dire « pas prévisible »,
 * jamais « zéro ».
 */
function useMesuresAudience(
  tenantId: string,
  etat: EtatCampagne,
  chaine: EtageAssistant[],
  champs: ReferencesContenu['userFields'],
): MesuresAudience | null {
  const [retenus, setRetenus] = useState<number | null>(null);
  /** Les contacts qui SURVIVENT au filtre « écarter les connus injoignables », pas les injoignables. */
  const [restants, setRestants] = useState<number | null>(null);
  const [sansAdresse, setSansAdresse] = useState<number | null>(null);

  const filtres = useMemo(() => filtresDeLAudience(etat.audience), [etat.audience]);
  const tries = useMemo(() => [...chaine].sort((a, b) => a.rang - b.rang), [chaine]);
  // ⚠️ LA JOIGNABILITÉ MÉMORISÉE EST CELLE DE WHATSAPP, ET D'ELLE SEULE (migration 0133). Un premier
  // étage RCS n'a donc rien à compter : l'appliquer quand même ferait basculer un chiffre mesuré sur un
  // autre canal, ce qui est pire qu'une case vide.
  const premierEstWhatsApp = tries[0]?.canal === 'whatsapp';
  // ⚠️ LE MÊME POINT DE PASSAGE QUE LE SÉLECTEUR ET QUE L'ENVOI (`champEmailDeLaChaine`) : appliquer la
  // suggestion ici de son côté ferait compter sur un champ que l'écran n'affiche pas, ou ne rien compter.
  const champEmail = champEmailDeLaChaine(etat, tries, champs);

  useEffect(() => {
    let vivant = true;
    setRetenus(null);
    void countContacts(tenantId, filtres)
      .then((r) => { if (vivant) setRetenus(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId, filtres]);

  useEffect(() => {
    let vivant = true;
    setRestants(null);
    if (!premierEstWhatsApp) return () => { vivant = false; };
    // ⚠️ ON COMPTE CE QUI RESTE APRÈS AVOIR ÉCARTÉ LES INJOIGNABLES, puis on soustrait dans
    // `repartitionPrevue`. Le filtre du mini-CRM sait EXCLURE les connus injoignables ; il n'a pas de
    // forme qui les ISOLE, et en inventer une ici donnerait un second vocabulaire de ciblage à tenir
    // d'accord avec celui du serveur.
    void countContacts(tenantId, { ...filtres, joignabiliteWhatsApp: 'connu_injoignable' })
      .then((r) => { if (vivant) setRestants(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId, filtres, premierEstWhatsApp]);

  useEffect(() => {
    let vivant = true;
    setSansAdresse(null);
    if (!champEmail) return () => { vivant = false; };
    void countContacts(tenantId, {
      ...filtres,
      fieldFilters: [...(filtres.fieldFilters ?? []), { key: champEmail, op: 'empty', value: '' }],
    })
      .then((r) => { if (vivant) setSansAdresse(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId, filtres, champEmail]);

  if (retenus === null) return null;
  return {
    retenus,
    // ⚠️ `retenus - restants` : le second compte est celui des contacts qui SURVIVENT au filtre, donc la
    // différence est bien le nombre de connus injoignables, sur la même sélection et au même instant.
    connusInjoignables: restants === null ? null : Math.max(0, retenus - restants),
    sansAdresse,
  };
}

/**
 * LA CLÉ DU CHAMP D'ADRESSE DE LA CHAÎNE, ou `null` si la chaîne n'a pas d'étage e-mail.
 *
 * 🔴 TROIS LECTEURS, UNE SEULE RÈGLE. Le sélecteur de l'étape Contenu affiche ce champ, le comptage du
 * récapitulatif compte dessus, et l'envoi l'écrit en base. Chacun appliquant la suggestion de son côté,
 * l'écran pourrait montrer un champ, compter sur un autre et en enregistrer un troisième, sans qu'aucun
 * compilateur ne le voie.
 */
function champEmailDeLaChaine(
  etat: EtatCampagne,
  chaine: EtageAssistant[],
  champs: ReferencesContenu['userFields'],
): string | null {
  const etage = chaine.find((e) => e.canal === 'email');
  if (!etage) return null;
  return champEmailEffectif(etat.contenus[etage.rang]?.emailChamp, champs);
}
