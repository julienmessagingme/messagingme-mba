'use client';

import { useState } from 'react';
import { CsvImport } from '@/components/CsvImport';
import { HubspotListImport } from '@/components/HubspotListImport';
import { fmtNum } from '@/lib/format';
import {
  filtresDesImportes, nbRetenus, selectionTout,
  type AudienceChoix, type SourceAudience,
} from '@/lib/audience';
import { ListeDestinataires, useContactsFiltres } from '@/components/campagne/ListeDestinataires';
import type { CapacitesEspace, EtatCampagne, ReferencesContenu } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 4 : QUI reçoit.
 *
 * 🔴 ELLE ARRIVE APRÈS LE CONTENU, ET C'EST UN CHOIX ASSUMÉ (décision d'ordre du 2026-09-12). On
 * compose d'abord ce qu'on veut dire, on choisit ensuite à qui : c'est l'ordre naturel d'une campagne,
 * et c'est celui qui évite de figer une audience avant de savoir ce qu'on lui envoie. Le prix de cet
 * ordre est que l'opérateur a réglé son repli sans savoir combien de monde il concerne, et c'est le
 * RÉCAPITULATIF qui le rachète : il montre la répartition, pas un résumé.
 *
 * 🔴 ELLE SAIT CE QUE `CampaignCreateForm` SAIT, ET PAR LES MÊMES BRIQUES (2026-09-13). Elle a été
 * livrée réduite à deux boutons radio, et le plan rangeait la sélection fine en « capacité manquante » à
 * traiter plus tard : vu de l'utilisateur, ce n'est pas une capacité absente, c'est une RÉGRESSION. Les
 * filtres du mini-CRM, les exclusions, l'import de fichier, les listes HubSpot et les cases à cocher
 * reviennent donc, en RÉUTILISANT les composants de l'écran en service (`ContactFilterPanel`,
 * `CsvImport`, `HubspotListImport`, `ListeDestinataires`). Toute ligne réécrite ici aurait donné une
 * seconde définition de l'audience, à tenir d'accord avec la première à la main.
 *
 * 🔴 LE COMPTE VIENT DU SERVEUR, PAS D'UNE LISTE RAPATRIÉE. `countContacts` rend un nombre ; charger les
 * contacts pour les compter dans le navigateur est exactement ce que l'audit du 2026-09-02 a fermé
 * (« tout sélectionner » rapatriait jusqu'à 100 000 identifiants, et la création échouait vers 25 000
 * sur le plafond de 1 Mo du corps de requête).
 *
 * ⚠️ UNE SEULE COLONNE, BLOCS EMPILÉS. Même règle que les étapes 2 et 3 : sur un 13 pouces la console
 * laisse environ 990 px utiles, et une grille qui se réorganise sous un seuil produit précisément les
 * chevauchements que ce lot existe pour empêcher.
 *
 * ⚠️ LA CASE « ÉCARTER LES INJOIGNABLES » A DISPARU AU PROFIT DU PANNEAU DE FILTRES, qui porte la MÊME
 * question (« Joignabilité WhatsApp : sauf les injoignables connus », clé `joignabiliteWhatsApp`).
 * Garder les deux aurait donné deux commandes pour un seul filtre, c'est-à-dire la divergence en
 * miniature : cocher l'une sans l'autre, et l'écran ne sait plus dire ce qui est posé.
 */
export function EtapeAudience({
  tenantId,
  etat,
  references,
  capacites,
  onChange,
}: {
  tenantId: string;
  etat: EtatCampagne;
  references: ReferencesContenu;
  capacites: CapacitesEspace;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  const audience = etat.audience;
  const modifier = (patch: Partial<AudienceChoix>): void => onChange({ audience: { ...audience, ...patch } });
  /** Un import en vol GÈLE les boutons de source : changer de source démonterait l'import et sa requête. */
  const [importEnCours, setImportEnCours] = useState(false);

  const page = useContactsFiltres({
    tenantId,
    filtres: audience.filtres,
    actif: audience.source === 'crm',
    selection: audience.selection,
    onSelection: (selection) => modifier({ selection }),
  });

  /**
   * APRÈS UN IMPORT, LES CONTACTS SONT DANS LE CRM ET TAGGÉS : on pivote sur la source CRM, filtrée par
   * leur(s) tag(s), et on vise « tout ce qui correspond ».
   *
   * ⚠️ `selectionTout()` PLUTÔT QUE LES LIGNES AFFICHÉES, et c'est là que cet écran s'écarte
   * volontairement de `CampaignCreateForm` : la liste est plafonnée à 500, or un fichier de 2 000
   * contacts vient d'être importé. Cocher les 500 affichées ferait partir la campagne à un quart du
   * fichier, en affichant « 500 » comme si c'était tout. Le filtre de tag, lui, les désigne tous.
   */
  const apresImport = (tags: string[]): void => {
    modifier({ source: 'crm', filtres: filtresDesImportes(tags), selection: selectionTout() });
  };

  /**
   * 🔴 CHANGER DE SOURCE OUBLIE CE QUI ÉTAIT VISÉ. Sans ça : on clique « Tout sélectionner » sur le CRM
   * (filtres vides = tout l'espace), on bascule sur « Import fichier », et l'écran montre un widget
   * d'upload vide pendant que l'état retient encore la cible du CRM. Plus rien à l'écran ne dit ce qui
   * est visé, et lancer enverrait à tout l'espace.
   */
  const choisirSource = (source: SourceAudience): void => {
    modifier({ source, selection: selectionTout() });
  };

  const retenus = nbRetenus(audience.selection, page.total);
  const hubspotVisible = capacites.hubspotListes;

  return (
    <section data-testid="etape-audience" className="w-full">
      <h2 className="text-lg font-semibold text-ink-800">Audience</h2>
      <p className="mt-1 text-sm text-ink-500">
        Les contacts sans consentement marketing et ceux qui sont bloqués sont écartés à la création, quel
        que soit ce choix.
      </p>

      {/* Sélecteur de SOURCE, mêmes trois entrées et même geste que l'écran en service. Le webhook (une
          campagne « au fil de l'eau ») n'est PAS ici : il n'a aucune liste, c'est une autre nature de
          campagne, et l'assistant ne la propose pas encore. */}
      <div className="mt-4 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm" data-testid="audience-sources">
        <BoutonSource
          actif={audience.source === 'crm'}
          desactive={importEnCours}
          onClick={() => choisirSource('crm')}
          libelle="📇 Liste de contacts"
        />
        <BoutonSource
          actif={audience.source === 'fichier'}
          desactive={importEnCours}
          onClick={() => choisirSource('fichier')}
          libelle="📄 Import fichier"
        />
        {/* ⚠️ HUBSPOT N'APPARAÎT PAS QUAND LE CONNECTEUR EST ÉTEINT (demande de Julien du 2026-08-26) :
            un bouton grisé pour une intégration qu'on n'a pas est du bruit, pas une information. En
            PAUSE, en revanche, il s'affiche grisé AVEC sa raison : l'empêchement est levable. */}
        {hubspotVisible && (
          <BoutonSource
            actif={audience.source === 'hubspot'}
            desactive={importEnCours || capacites.hubspotEnPause}
            onClick={() => choisirSource('hubspot')}
            libelle="🔗 HubSpot"
            aide={capacites.hubspotEnPause ? "Synchronisation HubSpot en pause. Réactive-la sur l'accueil." : undefined}
            testId="audience-source-hubspot"
          />
        )}
      </div>

      <div className="mt-3 w-full">
        {audience.source === 'fichier' ? (
          <CsvImport
            tenantId={tenantId}
            requireTag
            onImported={({ tags }) => apresImport(tags)}
            onBusyChange={setImportEnCours}
          />
        ) : audience.source === 'hubspot' ? (
          <HubspotListImport
            tenantId={tenantId}
            onImported={({ tags }) => apresImport(tags)}
            onBusyChange={setImportEnCours}
          />
        ) : (
          <ListeDestinataires
            page={page}
            filtres={audience.filtres}
            onFiltres={(filtres) => modifier({ filtres })}
            selection={audience.selection}
            onSelection={(selection) => modifier({ selection })}
            userFields={references.userFields}
            tagSuggestions={references.tags.map((tc) => tc.tag)}
          />
        )}
      </div>

      {/*
        ⚠️ LE COMPTE RESTE AFFICHÉ HORS DE LA SOURCE CRM, et il dit alors ce qu'il sait. Un import en
        cours ne change pas encore l'audience : le masquer ferait croire qu'il n'y en a plus.
      */}
      <p className="mt-4 text-sm text-ink-700" data-testid="audience-compte">
        {audience.source !== 'crm'
          ? <span className="text-ink-500">L&apos;import choisira les contacts : ils seront visés par leur étiquette.</span>
          : page.enCours
            ? 'Comptage...'
            : page.total === null
              // ⚠️ UNE LECTURE EN ÉCHEC N'AFFICHE PAS ZÉRO. Zéro est une réponse (« personne ne
              // correspond ») ; la confondre avec une panne ferait croire à une audience vide alors que
              // l'écran n'a simplement pas pu compter.
              ? <span className="text-gold">Le nombre de contacts n&apos;a pas pu être lu.</span>
              : <><b>{fmtNum(retenus, 'fr')}</b> contacts retenus</>}
      </p>
    </section>
  );
}

/**
 * Un bouton de source, dont le NOM ACCESSIBLE est exactement son libellé.
 *
 * ⚠️ Même invariant que les radios des étapes 2 et 3 : rien d'autre que le libellé, sinon aucune requête
 * par rôle ne peut désigner la commande sans réciter sa phrase entière.
 */
function BoutonSource({
  actif, desactive, onClick, libelle, aide, testId,
}: {
  actif: boolean;
  desactive?: boolean;
  onClick: () => void;
  libelle: string;
  aide?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={desactive === true}
      onClick={onClick}
      {...(aide ? { title: aide } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      className={`rounded-md px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${actif ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
    >
      {libelle}
    </button>
  );
}
