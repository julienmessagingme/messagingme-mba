'use client';

import {
  reessaiProposable,
  type CanalPremier,
  type EtageAssistant,
  type FormuleCanal,
  type TroisiemeNiveau,
} from '@/lib/campagne-chaine';
import { heuresDOuvertureReglees } from '@/lib/campagne-chaine';
import type { CapacitesEspace, EtatCampagne } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 2 : le canal, le repli, le réessai, et UNE question d'horaire.
 *
 * 🔴 UNE QUESTION À LA FOIS, ET LA PREMIÈRE EST LE CANAL (2026-09-14, demande de Julien) : « tu poses
 * d'abord la question du canal, avant de faire apparaître (ou pas) Réessayer les envois qui échouent, car
 * ce truc ne doit apparaître que si la personne choisit WhatsApp ou choisit RCS ; de même Envoyer
 * uniquement pendant les heures ouvrées, tu le fais apparaître quand on a rempli le reste ». L'écran
 * ouvrait sur quatre blocs d'un coup, dont trois dépendaient d'une réponse pas encore donnée.
 *
 * ⚠️ CE N'EST PAS QU'UN MASQUAGE : LE CANAL N'A PLUS DE DÉFAUT (`EtatCampagne.formule` vaut `null` à
 * l'ouverture). Garder « WhatsApp » coché tout en cachant ses conséquences aurait montré un choix que
 * personne n'a fait, et laissé partir une campagne WhatsApp sans un seul clic. Le bouton « Suivant » est
 * donc gardé, et il dit pourquoi.
 *
 * 🔴 UNE SEULE QUESTION D'HORAIRE, ET C'EST UN RETOUR EN ARRIÈRE ASSUMÉ (2026-09-13). L'écran en a porté
 * DEUX pendant une journée, avec l'argument qu'elles parlaient de moments différents : l'envoi initial
 * que l'opérateur choisit, et le rattrapage que personne ne choisit. L'argument était juste et la
 * conclusion fausse. Julien l'a tranché sur son essai réel : « cette option vaut pour les primo messages
 * et pour les relances, avec fallback ou pas ». Deux cases voisines parlant d'heures d'ouverture, avec
 * des sens OPPOSÉS sur l'absence d'horaires, demandaient à l'opérateur d'arbitrer ce que le produit doit
 * tenir lui-même. `rattrapage_hors_horaires` est désormais dérivée dans `entreeDeCreation`.
 *
 * 🔴 UNE SEULE COLONNE, DES BLOCS EMPILÉS, JAMAIS CÔTE À CÔTE. Sur un 13 pouces (1280 x 800), la console
 * laisse 990 px utiles une fois retirées la barre latérale de 240 px et les marges. Une grille qui se
 * réorganiserait sous un seuil produirait exactement les chevauchements que ce lot existe pour
 * empêcher ; l'empilement, lui, n'a pas de seuil. `web/e2e/campagne-assistant-canal.spec.ts` le MESURE.
 */
export function EtapeCanal({
  etat,
  chaine,
  capacites,
  onChange,
}: {
  etat: EtatCampagne;
  chaine: EtageAssistant[];
  capacites: CapacitesEspace;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  const rcsIndisponible = !capacites.rcsEnabled;
  const second: CanalPremier = etat.premier === 'whatsapp' ? 'rcs' : 'whatsapp';
  const canalChoisi = etat.formule !== null;
  /**
   * ⚠️ `canalChoisi` EST DANS LA CONDITION, ET PAS SEULEMENT DANS L'ENVELOPPE QUI L'ENTOURE.
   * `reessaiProposable([])` rend VRAI (une chaîne vide n'a pas de repli), donc la seule lecture de la
   * chaîne proposerait le réessai avant même qu'un canal existe. La fonction n'est pas fautive, c'est sa
   * question qui n'a pas de sens sans chaîne : on ne la pose donc pas.
   */
  const montreReessai = canalChoisi && reessaiProposable(chaine);
  const horairesReglees = heuresDOuvertureReglees(capacites.businessHours);

  return (
    <section data-testid="etape-canal" className="w-full">
      <h2 className="text-lg font-semibold text-ink-800">Par quel canal partent les messages ?</h2>

      <fieldset data-testid="choix-canal" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
        <legend className="px-1 text-sm font-medium text-ink-700">Canal</legend>
        <div className="space-y-2">
          <Entree
            groupe="formule"
            libelle="WhatsApp"
            description="Un template approuvé par Meta, envoyé depuis votre numéro."
            coche={etat.formule === 'whatsapp'}
            onCheck={() => onChange({ formule: 'whatsapp' })}
          />
          <Entree
            groupe="formule"
            libelle="RCS"
            description="Un message riche, avec ses suggestions, depuis votre agent RCS."
            coche={etat.formule === 'rcs'}
            desactive={rcsIndisponible}
            onCheck={() => onChange({ formule: 'rcs' })}
          />
          <Entree
            groupe="formule"
            libelle="WhatsApp et RCS, avec repli"
            description="Un envoi qui échoue repart aussitôt sur l'autre canal, sans double envoi."
            coche={etat.formule === 'repli'}
            desactive={rcsIndisponible}
            onCheck={() => onChange({ formule: 'repli' })}
          />
        </div>
        {/* 🔴 GRISÉ AVEC SA RAISON, JAMAIS MASQUÉ. Une option absente fait croire que la fonctionnalité
            n'existe pas ; une option grisée sans raison fait croire à une panne. On dit donc pourquoi,
            et où aller la régler. */}
        {rcsIndisponible && (
          <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
            Aucun agent RCS n&apos;est relié à cet espace. Reliez-en un dans Paramètres pour ouvrir ce
            canal et le repli.
          </p>
        )}
      </fieldset>

      {/* 🔴 UN BOUTON GRISÉ DIT POURQUOI IL L'EST. C'est la règle du produit (un canal indisponible est
          grisé AVEC sa raison, un étage sans contenu est nommé), et elle vaut ici : sans canal, « Suivant »
          est gardé, et rien d'autre n'apparaît à l'écran. Sans cette phrase, l'écran ressemblerait à une
          page à moitié chargée. */}
      {!canalChoisi && (
        <p className="mt-3 text-sm text-ink-600" data-testid="canal-a-choisir">
          Choisissez un canal : la suite des questions en dépend.
        </p>
      )}

      {etat.formule === 'repli' && (
        <fieldset data-testid="choix-ordre" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
          <legend className="px-1 text-sm font-medium text-ink-700">Lequel part en premier ?</legend>
          <div className="space-y-2">
            <Entree
              groupe="premier"
              libelle="WhatsApp en premier"
              coche={etat.premier === 'whatsapp'}
              onCheck={() => onChange({ premier: 'whatsapp' })}
            />
            <Entree
              groupe="premier"
              libelle="RCS en premier"
              coche={etat.premier === 'rcs'}
              onCheck={() => onChange({ premier: 'rcs' })}
            />
          </div>
          {/* ⚠️ LE SECOND S'AFFICHE, IL NE SE CHOISIT PAS : le proposer ouvrirait « WhatsApp puis
              WhatsApp », qui n'est pas un repli mais un réessai déguisé. */}
          <p className="mt-3 text-xs text-ink-500">
            En cas d&apos;échec, le repli part en {second === 'rcs' ? 'RCS' : 'WhatsApp'}.
          </p>
        </fieldset>
      )}

      {etat.formule === 'repli' && (
        <fieldset data-testid="choix-troisieme" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
          <legend className="px-1 text-sm font-medium text-ink-700">Un troisième niveau ?</legend>
          <div className="space-y-2">
            <Entree
              groupe="troisieme"
              libelle="Non"
              coche={etat.troisieme === 'aucun'}
              onCheck={() => onChange({ troisieme: 'aucun' })}
            />
            {/* 🔴 L'E-MAIL EST GRISÉ, ET CE N'EST PAS UNE PRUDENCE : IL N'ENVERRAIT RIEN (2026-09-12).
                La chaîne sait le décrire, `campaign_etages` sait le stocker, la bascule sait y arriver, et
                `run-job` n'a AUCUN sender pour ce canal. Le laisser cochable offrait donc un étage qui se
                configure, s'enregistre, et reste inerte sans qu'aucune erreur ne le dise nulle part.
                ⚠️ Offert-et-inerte est PIRE que masqué : masqué, on cherche ailleurs ; offert, on croit
                l'avoir. C'est le même arbitrage que le SMS juste en dessous, et il se règle pareil. */}
            <Entree
              groupe="troisieme"
              libelle="E-mail"
              badge="bientôt"
              coche={false}
              desactive
              onCheck={() => {}}
            />
            {/* 🔴 LE SMS EST MONTRÉ, GRISÉ : montrer ce qui arrive vaut mieux que laisser croire que ça
                n'existera jamais, et l'emplacement est celui où on le cherchera le jour venu. */}
            <Entree
              groupe="troisieme"
              libelle="SMS"
              badge="bientôt"
              coche={false}
              desactive
              onCheck={() => {}}
            />
          </div>
          {etat.troisieme === 'email' && (
            <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
              L&apos;e-mail part à l&apos;adresse portée par la fiche du contact. Un contact sans adresse
              sort de la chaîne avant ce niveau.
            </p>
          )}
        </fieldset>
      )}

      {/* 🔴 LA CONDITION SE LIT SUR LA CHAÎNE, PLUS SUR LA FORMULE (2026-09-13). Les deux disent la même
          chose aujourd'hui, mais `reessaiProposable` est la MÊME fonction que celle qui tranche au point
          d'envoi (`entreeDeCreation`) : c'est ce qui garantit que ce qu'on cache est exactement ce
          qu'on n'envoie pas. Deux règles écrites séparément auraient divergé le jour où une quatrième
          formule apparaît. */}
      {montreReessai && (
        <div data-testid="bloc-reessai" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
          {/* 🔴 « RÉESSAYER », JAMAIS « RELANCER ». En marketing, relancer quelqu'un veut dire lui
              renvoyer un message parce qu'il n'a pas répondu. Ici il s'agit de retenter un envoi qui a
              échoué techniquement, avant même que le destinataire ait vu quoi que ce soit : qui lit
              « relancer » coche pour une raison qui n'est pas la bonne. */}
          <Case
            libelle="Réessayer les envois qui échouent"
            description="Un envoi bloqué par une limite de Meta est retenté le lendemain matin ; un numéro non délivrable est retenté une fois, puis marqué injoignable. Sans chaîne de repli, c'est le seul rattrapage disponible."
            coche={etat.reessayer}
            onChange={(v) => onChange({ reessayer: v })}
          />
        </div>
      )}

      {/*
        🔴 LA QUESTION DU RATTRAPAGE A ÉTÉ RETIRÉE (2026-09-13, tranché par Julien sur son essai réel) :
        « ne sert à rien, on a juste besoin d'Envoyer uniquement pendant les heures ouvrées, cette option
        vaut pour les primo messages et pour les relances, avec fallback ou pas ». Deux cases voisines
        parlant toutes deux d'heures d'ouverture, avec des sens opposés sur l'absence d'horaires,
        demandaient à l'opérateur de trancher un arbitrage que le produit doit tenir lui-même.

        ⚠️ LA COLONNE N'A PAS DISPARU, ELLE EST DÉRIVÉE. `rattrapage_hors_horaires` (migration 0134) vaut
        désormais l'inverse de la case ci-dessous, et c'est `entreeDeCreation` qui l'écrit. Le moteur
        et le balayage de rattrapage n'ont pas bougé d'une ligne : seule la question a disparu.
      */}

      {/*
        🔴 LA CADENCE N'EST PLUS ICI, ET CE N'EST PAS UN OUBLI (2026-09-12). Cet écran a porté trois
        « intentions » (au plus vite, étalé sur la journée, heures ouvrées seulement) qui n'ont JAMAIS été
        demandées : elles venaient d'une recommandation écrite dans la spec et non validée, et elles
        retiraient la jauge que l'ancien formulaire offrait depuis toujours. La jauge revient, et elle vit
        à la FIN du parcours (étape 5), là où l'audience est connue : c'est le seul endroit où une durée
        estimée veut dire quelque chose. Ce qui reste ici, c'est la seule question horaire demandée.
      */}
      {/* 🔴 EN DERNIER, ET SEULEMENT UNE FOIS LE CANAL CHOISI (2026-09-14) : « tu le fais apparaître
          quand on a rempli le reste ». Tout ce qui précède (l'ordre du repli, son troisième niveau, le
          réessai) découle du canal et porte déjà sa réponse par défaut une fois le canal connu ; cette
          case-ci, elle, ne dépend d'aucune des autres, c'est pourquoi elle ferme la marche plutôt que
          d'attendre un clic de plus. */}
      {canalChoisi && (
        <div data-testid="bloc-horaires" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
          <Case
            libelle="Envoyer uniquement pendant les heures ouvrées"
            description="Lancée hors créneau, la campagne attend la prochaine ouverture (onglet Paramètres) au lieu de partir. Un envoi que la fermeture interrompt reprend tout seul au créneau suivant, sans perdre un destinataire."
            coche={etat.heuresOuvrees}
            onChange={(v) => onChange({ heuresOuvrees: v })}
          />
          {/*
            🔴 SANS AUCUN JOUR OUVERT, CETTE CASE NE RETARDE PAS L'ENVOI : ELLE L'ANNULE. Vérifié dans le
            code, pas déduit du libellé : `withinBusinessHours` rend faux sur des horaires vides, le moteur
            met donc la campagne en pause `hors_horaires`, et `prochaineOuverture` ne trouvant aucune
            reprise, `paused_until` reste nul. Or le balayage de reprise exige `paused_until is not null`
            (`reprendreCampagnesDues`) : la campagne reste en pause POUR TOUJOURS, sans qu'aucune erreur ne
            le dise.

            ⚠️ CE FUT L'INVERSE DE LA CASE DU RATTRAPAGE, qui vivait juste au-dessus jusqu'au 2026-09-13 et
            pour qui l'absence d'horaires rendait la fenêtre TOUJOURS ouverte. Deux cases voisines, deux
            comportements opposés sur la même absence : c'est une des raisons pour lesquelles la seconde a
            été retirée. Le dire au moment où l'on coche reste la seule façon de ne pas se faire avoir.

            ⚠️ ET CE CAS EXISTE VRAIMENT : l'espace de démonstration n'avait AUCUNE heure réglée en base le
            2026-09-13, ce qui ne se voyait pas à l'écran parce que l'API rend des heures PAR DÉFAUT
            (lundi-vendredi 9 h-18 h, `DEFAULT_BUSINESS_HOURS`) quand la colonne est nulle. Cet
            avertissement ne s'affiche donc JAMAIS aujourd'hui : `heuresDOuvertureReglees` reçoit le défaut
            et répond « oui ». La console ne sait pas distinguer « réglé » de « jamais réglé », et c'est
            une limite connue, pas un oubli de câblage.
          */}
          {etat.heuresOuvrees && !horairesReglees && (
            <p className="mt-3 rounded-lg bg-gold/10 px-3 py-2 text-xs text-ink-700" data-testid="horaires-absentes">
              Aucune heure d&apos;ouverture n&apos;est réglée pour cet espace : cochée, cette case mettrait la
              campagne en pause sans jamais la reprendre. Réglez vos horaires dans Paramètres, ou décochez.
            </p>
          )}
        </div>
      )}

    </section>
  );
}

/**
 * Une entrée de liste à choix unique.
 *
 * ⚠️ LE NOM ACCESSIBLE DE LA COMMANDE EST EXACTEMENT `libelle`, et c'est une contrainte de test autant
 * que d'accessibilité : la description vit HORS du `<label>`, sinon elle entrerait dans le nom accessible
 * du bouton radio et aucune requête par rôle ne pourrait plus le désigner sans réciter sa phrase.
 */
function Entree({
  groupe,
  libelle,
  description,
  badge,
  coche,
  desactive,
  onCheck,
}: {
  groupe: string;
  libelle: string;
  description?: string;
  badge?: string;
  coche: boolean;
  desactive?: boolean;
  onCheck: () => void;
}) {
  return (
    <div className={`w-full rounded-lg border p-3 ${coche ? 'border-brand-400 bg-brand-50/40' : 'border-ink-200'} ${desactive ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink-800">
          <input
            type="radio"
            name={groupe}
            checked={coche}
            disabled={desactive === true}
            onChange={onCheck}
            className="h-4 w-4 shrink-0 accent-brand-500"
          />
          <span className="min-w-0 break-words">{libelle}</span>
        </label>
        {badge && <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-500">{badge}</span>}
      </div>
      {description && <p className="mt-1 pl-6 text-xs text-ink-500">{description}</p>}
    </div>
  );
}

/** Une case à cocher, même doctrine de nom accessible que `Entree`. */
function Case({
  libelle,
  description,
  coche,
  onChange,
}: {
  libelle: string;
  description?: string;
  coche: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="w-full">
      <label className="flex items-center gap-2 text-sm font-medium text-ink-800">
        <input
          type="checkbox"
          checked={coche}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 shrink-0 rounded border-ink-300 accent-brand-500"
        />
        <span className="min-w-0 break-words">{libelle}</span>
      </label>
      {description && <p className="mt-1 pl-6 text-xs text-ink-500">{description}</p>}
    </div>
  );
}

/** Réexporté pour que l'étape suivante n'ait pas à réimporter le type depuis deux endroits. */
export type { FormuleCanal, TroisiemeNiveau };
