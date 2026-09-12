'use client';

import {
  rattrapagePossible,
  type Cadence,
  type CanalPremier,
  type EtageAssistant,
  type FormuleCanal,
  type TroisiemeNiveau,
} from '@/lib/campagne-chaine';
import { heuresDOuvertureReglees } from '@/lib/campagne-chaine';
import type { CapacitesEspace, EtatCampagne } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 2 : le canal, le repli, le réessai, l'horaire du rattrapage, et la cadence.
 *
 * 🔴 UNE SEULE COLONNE, DES BLOCS EMPILÉS, JAMAIS CÔTE À CÔTE. C'est l'étape la plus chargée de
 * l'assistant : trois entrées de canal, deux sous-questions, une case à cocher, un encart
 * d'avertissement et trois cadences. Sur un 13 pouces (1280 x 800), la console laisse environ 990 px
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
            <Entree
              groupe="troisieme"
              libelle="E-mail"
              coche={etat.troisieme === 'email'}
              onCheck={() => onChange({ troisieme: 'email' })}
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

      <fieldset data-testid="choix-cadence" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
        <legend className="px-1 text-sm font-medium text-ink-700">À quel rythme ?</legend>
        {/* 🔴 L'ÉCRAN NE DEMANDE PLUS UN NOMBRE DE MESSAGES PAR MINUTE. Un marketeur n'a aucun moyen de
            connaître les plafonds des opérateurs : il choisit une INTENTION, le plafond technique reste
            en coulisse (`plafondDuCanal`, côté serveur). Ce que chaque intention écrit sur la campagne
            est dans `reglagesDeCadence` (`web/lib/campagne-chaine.ts`), avec la raison du chiffre. */}
        <div className="space-y-2">
          <Entree
            groupe="cadence"
            libelle="Au plus vite"
            description="Le débit par défaut du serveur, ramené au plafond du canal."
            coche={etat.cadence === 'vite'}
            onCheck={() => onChange({ cadence: 'vite' })}
          />
          <Entree
            groupe="cadence"
            libelle="Étalé sur la journée"
            description="Un débit volontairement bas, pour ménager la réputation du numéro et laisser l'équipe absorber les réponses."
            coche={etat.cadence === 'etale'}
            onCheck={() => onChange({ cadence: 'etale' })}
          />
          <Entree
            groupe="cadence"
            libelle="Heures ouvrées seulement"
            description="Lancée hors créneau, la campagne attend la prochaine ouverture. Un envoi que la fermeture interrompt reprend au créneau suivant."
            coche={etat.cadence === 'ouvrees'}
            onCheck={() => onChange({ cadence: 'ouvrees' })}
          />
        </div>
      </fieldset>
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
export type { Cadence, FormuleCanal, TroisiemeNiveau };
