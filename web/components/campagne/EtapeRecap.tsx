'use client';

import { useEffect, useMemo, useState } from 'react';
import { countContacts, createCampaign, runCampaign } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { DEBIT_MAX, DEBIT_MIN, type EtageAssistant } from '@/lib/campagne-chaine';
import { audienceEnFiltres, libelleAudience, nbRetenus } from '@/lib/audience';
import {
  LIBELLE_CANAL, champEmailEffectif, repartitionPrevue,
  type MesuresAudience,
} from '@/lib/campagne-repartition';
import { entreeDeCreation, problemeAvantLancement, variablesParRang } from '@/lib/campagne-creation';
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
  onChange,
  onCree,
}: {
  tenantId: string;
  etat: EtatCampagne;
  chaine: EtageAssistant[];
  references: ReferencesContenu;
  /** Revenir à une étape, sans quitter l'assistant ni perdre l'état. */
  aller: (e: EtapeAssistant) => void;
  /** La jauge de débit se règle ICI : c'est le seul écran qui connaît l'audience. */
  onChange: (patch: Partial<EtatCampagne>) => void;
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
    filtres: etat.audience.filtres,
    /**
     * 🔴 CE QUI A ÉTÉ COCHÉ VOYAGE JUSQU'ICI. Sans cette ligne, `entreeDeCreation` n'emportait que les
     * FILTRES : une sélection ligne à ligne était affichée, comptée, et jamais envoyée. La campagne
     * partait alors à tout ce que les filtres décrivent, c'est-à-dire à plus de monde que ce que
     * l'opérateur avait sous les yeux.
     */
    selection: etat.audience.selection,
    // ⚠️ LE MÊME POINT DE PASSAGE que le comptage et que le sélecteur de l'étape Contenu
    // (`champEmailEffectif`) : trois lectures du même réglage, une seule règle pour le résoudre.
    champEmail: champEmailDeLaChaine(etat, chaine, references.userFields),
    /**
     * ⚠️ LE MÊME POINT DE PASSAGE QUE L'ÉTAPE CONTENU (`modeleDeLEtage`, via `variablesParRang`) : c'est
     * lui qui dit quel modèle un étage envoie, le sien ou celui par lequel son scénario ouvre. Le
     * recalculer ici de son côté ferait compter les variables d'un modèle que l'écran n'a pas proposé à
     * associer, donc refuser un lancement parfaitement valide.
     */
    variablesDuModele: variablesParRang(chaine, etat.contenus, references.templates),
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
        <span className="text-ink-500" data-testid="recap-audience-libelle">
          ({libelleAudience(etat.audience)})
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

      <BlocCout etat={etat} retenus={mesures?.retenus ?? null} onChange={onChange} />

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
 * LE DÉBIT, LE VOLUME ET LA DURÉE : ce que la campagne coûte, dit avec ce qu'on sait et rien de plus.
 *
 * 🔴 LA JAUGE DE DÉBIT VIT ICI, ET C'EST LE SEUL ENDROIT OÙ ELLE A UN SENS (2026-09-12). Elle a passé une
 * journée à l'étape du canal sous la forme de trois « intentions » (au plus vite, étalé, heures ouvrées)
 * qui n'avaient jamais été demandées et qui retiraient au client un réglage qu'il utilise. Placée ici,
 * l'audience est CONNUE : la durée estimée qu'elle affiche est un vrai nombre, pas une promesse.
 *
 * 🔴 AUCUN PRIX EN EUROS, ET CE N'EST PAS UN MANQUE D'AMBITION. Le tarif d'un message vient de Meta
 * APRÈS l'envoi (`pricing_analytics`, avec sa devise) ; rien avant le lancement ne donne un prix unitaire
 * pour ce numéro, cette catégorie et ce pays. Un montant affiché ici serait inventé, et il serait cru
 * parce qu'il est à côté du bouton qui envoie.
 */
function BlocCout({
  etat, retenus, onChange,
}: { etat: EtatCampagne; retenus: number | null; onChange: (patch: Partial<EtatCampagne>) => void }) {
  const debit = etat.debitParMinute;
  const minutes = retenus === null ? null : Math.max(1, Math.ceil(retenus / debit));
  return (
    <div className="mt-4 w-full rounded-xl border border-ink-200 p-4" data-testid="bloc-cout">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-ink-700">Débit d&apos;envoi</h3>
        <span className="shrink-0 text-sm font-semibold text-ink-800" data-testid="debit-valeur">
          {debit} messages / min
        </span>
      </div>
      <input
        type="range"
        min={DEBIT_MIN}
        max={DEBIT_MAX}
        step={1}
        value={debit}
        onChange={(e) => onChange({ debitParMinute: Number(e.target.value) })}
        data-testid="campagne-debit"
        aria-label="Débit d'envoi en messages par minute"
        className="mt-3 w-full accent-brand-500"
      />
      {/*
        🔴 LE PLAFOND RÉEL DÉPEND DU CANAL, ET CETTE PHRASE NE DOIT PAS DIRE LE CONTRAIRE. La jauge monte
        toujours à 80, qui est la borne de SAISIE de l'API ; le frein appliqué à l'envoi est celui du
        canal (`plafondDuCanal`, côté serveur), donc un étage RCS réglé au-dessus du plafond de
        l'opérateur y est RAMENÉ, en silence.
        ⚠️ LE CHIFFRE DU PLAFOND RCS N'EST PAS RECOPIÉ ICI : il vit en configuration serveur pour se
        corriger sans déploiement, et une valeur en dur dans l'écran deviendrait fausse sans que rien ne
        le signale.
      */}
      <p className="mt-2 text-[11px] text-ink-400">
        Défaut 60/min. Plafond 80/min (limite WhatsApp) ; baisser le débit protège la réputation du
        numéro. Sur un étage RCS, le plafond est celui de l&apos;opérateur : un débit plus élevé y est
        ramené à l&apos;envoi.
      </p>

      <p className="mt-3 border-t border-ink-100 pt-3 text-sm text-ink-600">
        {retenus === null
          ? 'Le nombre de contacts retenus n’a pas pu être lu : le volume et la durée restent inconnus.'
          : <>Jusqu&apos;à <b>{fmtNum(retenus, 'fr')}</b> messages facturables au premier étage, plus un message par bascule.</>}
      </p>
      <p className="mt-1 text-sm text-ink-600" data-testid="recap-duree">
        {minutes === null
          ? 'Durée inconnue.'
          : <>Environ <b>{fmtNum(minutes, 'fr')}</b> min d&apos;envoi à {fmtNum(debit, 'fr')} messages/min.</>}
        {/* ⚠️ LA CONTRAINTE D'HORAIRE S'AJOUTE À LA DURÉE, elle ne la remplace pas : la campagne enverra
            bien ce nombre de minutes, mais réparties sur les créneaux ouverts. Annoncer « la durée dépend
            de vos créneaux » SEULE effaçait le seul chiffre que l'écran sait donner. */}
        {etat.heuresOuvrees && (
          <span className="mt-0.5 block text-xs text-ink-500">
            Envoi limité aux heures d&apos;ouverture de l&apos;espace : ces minutes se répartissent sur vos
            créneaux, la campagne se clôt donc plus tard.
          </span>
        )}
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
  /** Le total SERVEUR des contacts que les filtres décrivent. Inutile hors du mode « tout ce qui... ». */
  const [total, setTotal] = useState<number | null>(null);
  /** Les contacts qui SURVIVENT au filtre « écarter les connus injoignables », pas les injoignables. */
  const [restants, setRestants] = useState<number | null>(null);
  const [sansAdresse, setSansAdresse] = useState<number | null>(null);

  const selection = etat.audience.selection;
  const filtres = etat.audience.filtres;
  const tries = useMemo(() => [...chaine].sort((a, b) => a.rang - b.rang), [chaine]);
  // ⚠️ LA JOIGNABILITÉ MÉMORISÉE EST CELLE DE WHATSAPP, ET D'ELLE SEULE (migration 0133). Un premier
  // étage RCS n'a donc rien à compter : l'appliquer quand même ferait basculer un chiffre mesuré sur un
  // autre canal, ce qui est pire qu'une case vide.
  const premierEstWhatsApp = tries[0]?.canal === 'whatsapp';
  /**
   * 🔴 DEUX DES TROIS COMPTES N'EXISTENT QUE SUR UNE AUDIENCE DÉCRITE PAR SES FILTRES. `countContacts`
   * n'interroge que des filtres : une liste de contacts cochés un par un, ou un filtre amputé de ses
   * exclusions, ne se comptent pas de ce côté-là. On rend alors `null` AVEC SON MOTIF, plutôt qu'un
   * chiffre voisin qui serait cru parce qu'il est plausible.
   *
   * ⚠️ LE TOTAL, LUI, RESTE EXACT DANS LES DEUX CAS : en mode liste il vaut le nombre de cases cochées,
   * que le navigateur connaît sans rien demander.
   */
  const parFiltres = audienceEnFiltres(selection);
  const motif: MesuresAudience['motifNonPrevisible'] = !premierEstWhatsApp ? 'canal' : !parFiltres ? 'selection' : undefined;
  // ⚠️ LE MÊME POINT DE PASSAGE QUE LE SÉLECTEUR ET QUE L'ENVOI (`champEmailDeLaChaine`) : appliquer la
  // suggestion ici de son côté ferait compter sur un champ que l'écran n'affiche pas, ou ne rien compter.
  const champEmail = champEmailDeLaChaine(etat, tries, champs);

  useEffect(() => {
    let vivant = true;
    setTotal(null);
    // ⚠️ AUCUNE REQUÊTE EN MODE LISTE : le nombre retenu est celui des cases cochées, et le total des
    // filtres n'en dit rien. La demander quand même ferait payer un aller-retour pour un chiffre
    // qu'aucune phrase de l'écran n'affiche.
    if (!selection.toutFiltre) return () => { vivant = false; };
    void countContacts(tenantId, filtres)
      .then((r) => { if (vivant) setTotal(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId, filtres, selection.toutFiltre]);

  useEffect(() => {
    let vivant = true;
    setRestants(null);
    if (!premierEstWhatsApp || !parFiltres) return () => { vivant = false; };
    // ⚠️ ON COMPTE CE QUI RESTE APRÈS AVOIR ÉCARTÉ LES INJOIGNABLES, puis on soustrait dans
    // `repartitionPrevue`. Le filtre du mini-CRM sait EXCLURE les connus injoignables ; il n'a pas de
    // forme qui les ISOLE, et en inventer une ici donnerait un second vocabulaire de ciblage à tenir
    // d'accord avec celui du serveur.
    void countContacts(tenantId, { ...filtres, joignabiliteWhatsApp: 'connu_injoignable' })
      .then((r) => { if (vivant) setRestants(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId, filtres, premierEstWhatsApp, parFiltres]);

  useEffect(() => {
    let vivant = true;
    setSansAdresse(null);
    if (!champEmail || !parFiltres) return () => { vivant = false; };
    void countContacts(tenantId, {
      ...filtres,
      fieldFilters: [...(filtres.fieldFilters ?? []), { key: champEmail, op: 'empty', value: '' }],
    })
      .then((r) => { if (vivant) setSansAdresse(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId, filtres, champEmail, parFiltres]);

  // ⚠️ `null` TANT QUE LE TOTAL MANQUE, et seulement dans le mode qui en a besoin : en mode liste le
  // compte est connu tout de suite, et l'écran ne doit pas afficher « ... » pour rien.
  if (selection.toutFiltre && total === null) return null;
  const retenus = nbRetenus(selection, total);
  return {
    retenus,
    // ⚠️ `retenus - restants` : le second compte est celui des contacts qui SURVIVENT au filtre, donc la
    // différence est bien le nombre de connus injoignables, sur la même sélection et au même instant.
    connusInjoignables: restants === null ? null : Math.max(0, retenus - restants),
    sansAdresse,
    ...(motif ? { motifNonPrevisible: motif } : {}),
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
