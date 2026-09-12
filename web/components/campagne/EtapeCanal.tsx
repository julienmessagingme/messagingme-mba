'use client';

import {
  rattrapagePossible,
  type CanalPremier,
  type EtageAssistant,
  type FormuleCanal,
  type TroisiemeNiveau,
} from '@/lib/campagne-chaine';
import { heuresDOuvertureReglees } from '@/lib/campagne-chaine';
import type { CapacitesEspace, EtatCampagne } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 2 : le canal, le repli, le réessai, et les DEUX questions d'horaire.
 *
 * 🔴 LES DEUX QUESTIONS D'HORAIRE NE PARLENT PAS DU MÊME MOMENT, et c'est pour ça qu'elles cohabitent.
 * « Envoyer uniquement pendant les heures ouvrées » gouverne l'envoi INITIAL, celui que l'opérateur
 * CHOISIT en appuyant sur le bouton (`campaigns.business_hours_only`, migration 0122). Celle du
 * rattrapage gouverne le moment que PERSONNE ne choisit : un repli qui se présente à 18 h 02. Une
 * campagne peut parfaitement envoyer la nuit et refuser de rattraper la nuit, et c'est ce cas-là qui
 * prouve que la séparation est réelle (`src/lib/heures-ouvrees.ts` la porte côté serveur).
 *
 * 🔴 UNE SEULE COLONNE, DES BLOCS EMPILÉS, JAMAIS CÔTE À CÔTE. C'est l'étape la plus chargée de
 * l'assistant : trois entrées de canal, deux sous-questions, une case à cocher, un encart
 * d'avertissement et deux questions d'horaire. Sur un 13 pouces (1280 x 800), la console laisse 990 px
 * utiles une fois retirées la barre latérale de 240 px et les marges. Une grille qui se réorganiserait
 * sous un seuil produirait exactement les chevauchements que ce lot existe pour empêcher ; l'empilement,
 * lui, n'a pas de seuil. `web/e2e/campagne-assistant-canal.spec.ts` le MESURE, il ne le suppose pas.
 *
 * ⚠️ LA QUESTION DU RATTRAPAGE EST POSÉE UNE FOIS, EN BAS, ET C'EST UN CHOIX. Elle naît de DEUX causes
 * (un réessai coché, ou une chaîne) qui vivent dans deux branches différentes de l'écran. La poser dans
 * chaque branche en ferait deux exemplaires, donc deux nœuds portant le même libellé, et un lecteur qui
 * revient en arrière verrait la question changer de place. Elle reste donc à un seul endroit, le
 * dernier, c'est-à-dire APRÈS ce qui la fait apparaître : on lit la cause, puis sa conséquence.
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
  const montreRattrapage = rattrapagePossible({ reessayer: etat.reessayer, chaine });
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

      {etat.formule !== 'repli' && (
        <div data-testid="bloc-reessai" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
          {/* 🔴 « RÉESSAYER », JAMAIS « RELANCER ». En marketing, relancer quelqu'un veut dire lui
              renvoyer un message parce qu'il n'a pas répondu. Ici il s'agit de retenter un envoi qui a
              échoué techniquement, avant même que le destinataire ait vu quoi que ce soit : qui lit
              « relancer » coche pour une raison qui n'est pas la bonne. */}
          <Case
            libelle="Réessayer les envois qui échouent"
            description="Sans chaîne de repli, c'est le seul rattrapage disponible."
            coche={etat.reessayer}
            onChange={(v) => onChange({ reessayer: v })}
          />
        </div>
      )}

      {montreRattrapage && (
        <div data-testid="bloc-rattrapage" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
          {/* 🔴 LA CASE EST LA GARDE, ET ELLE EST COCHÉE PAR DÉFAUT (`rattrapageHorsHoraires` vaut faux).
              Un rattrapage tombe quand il tombe, personne n'en choisit l'instant : un repli déclenché à
              18 h 02 sur une campagne partie à 17 h est un message de nuit que personne n'a demandé. */}
          <Case
            libelle="Ne pas envoyer le rattrapage en dehors des heures d'ouverture"
            description="Un rattrapage qui se présente après la fermeture attend l'ouverture suivante : la campagne met plus longtemps à se clore, et ses chiffres restent incomplets entre-temps."
            coche={!etat.rattrapageHorsHoraires}
            onChange={(v) => onChange({ rattrapageHorsHoraires: !v })}
          />
          {/* 🔴 LE DIRE AU MOMENT OÙ L'ON COCHE. Sans aucun jour ouvert, la fenêtre de rattrapage est
              considérée comme TOUJOURS ouverte (`fenetreDeRattrapageOuverte`, vérifié dans le code) :
              cette case ne retient alors rien, et croire avoir posé une garde est pire que de ne pas
              l'avoir posée. */}
          {!etat.rattrapageHorsHoraires && !horairesReglees && (
            <p className="mt-3 rounded-lg bg-gold/10 px-3 py-2 text-xs text-ink-700">
              Aucune heure d&apos;ouverture n&apos;est réglée pour cet espace : le rattrapage partira donc
              à toute heure. Réglez-les dans Paramètres pour que cette case ait un effet.
            </p>
          )}
        </div>
      )}

      {/*
        🔴 LA CADENCE N'EST PLUS ICI, ET CE N'EST PAS UN OUBLI (2026-09-12). Cet écran a porté trois
        « intentions » (au plus vite, étalé sur la journée, heures ouvrées seulement) qui n'ont JAMAIS été
        demandées : elles venaient d'une recommandation écrite dans la spec et non validée, et elles
        retiraient la jauge que `CampaignCreateForm` offre depuis toujours. La jauge revient, et elle vit
        à la FIN du parcours (étape 5), là où l'audience est connue : c'est le seul endroit où une durée
        estimée veut dire quelque chose. Ce qui reste ici, c'est la seule question horaire demandée.
      */}
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

          ⚠️ C'EST L'INVERSE DE LA CASE DU RATTRAPAGE juste au-dessus, où l'absence d'horaires rend la
          fenêtre TOUJOURS ouverte. Deux cases voisines, deux comportements opposés sur la même absence :
          le dire au moment où l'on coche est la seule façon de ne pas se faire avoir.
        */}
        {etat.heuresOuvrees && !horairesReglees && (
          <p className="mt-3 rounded-lg bg-gold/10 px-3 py-2 text-xs text-ink-700" data-testid="horaires-absentes">
            Aucune heure d&apos;ouverture n&apos;est réglée pour cet espace : cochée, cette case mettrait la
            campagne en pause sans jamais la reprendre. Réglez vos horaires dans Paramètres, ou décochez.
          </p>
        )}
      </div>

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
