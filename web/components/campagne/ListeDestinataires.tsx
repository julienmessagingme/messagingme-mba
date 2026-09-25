'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ContactFilterPanel } from '@/components/ContactFilterPanel';
import { contactIdentity, queryContacts, countContacts, type Contact, type ContactFilters, type UserFieldDef } from '@/lib/api';
import { filtersActive } from '@/lib/contact-filters';
import { useT } from '@/lib/i18n';
import { estRetenu, nbRetenus, type SelectionDestinataires } from '@/lib/audience';
import { Bouton } from '@/components/Bouton';

/**
 * LA SÉLECTION DES DESTINATAIRES DANS LE MINI-CRM : les filtres, le compteur, et les cases à cocher.
 *
 * 🔴 POURQUOI C'EST UN COMPOSANT PARTAGÉ (2026-09-13). L'étape Audience de l'assistant a été livrée
 * RÉDUITE : deux boutons radio (« tous » / « ceux qui portent un de ces tags ») là où l'écran qu'elle
 * remplace offre les filtres complets du mini-CRM, les exclusions, l'import de fichier, les listes
 * HubSpot et la sélection ligne à ligne. Un écran qui sait faire MOINS que celui qu'il remplace n'est
 * pas un remplaçant, et la recopier aurait donné une seconde définition de l'audience, donc une
 * divergence programmée le jour où l'une des deux gagne un cas.
 *
 * ⚠️ CONTRÔLÉ : il ne garde AUCUNE décision de l'utilisateur. Les filtres et ce qui est coché vivent
 * chez l'appelant (l'état de l'assistant, ou les états du formulaire en service, qui les enregistre
 * dans son brouillon). Il ne porte que ce qui se DÉDUIT de `tenantId` + filtres : la page de contacts
 * et le total, que les deux écrans calculeraient de la même façon.
 */

/** Ce que le chargement d'une page de contacts rend à l'écran qui l'affiche. */
export interface PageDeContacts {
  contacts: Contact[];
  /** Le total SERVEUR, pas le nombre de lignes ramenées. `null` = inconnu (jamais « zéro »). */
  total: number | null;
  enCours: boolean;
}

/** La sélection restaurée d'un brouillon, à appliquer au PREMIER chargement et à lui seul. */
export interface RestaurationSelection {
  selected: Set<string>;
  exclus: Set<string>;
}

/** Le plafond de lignes affichées. Au-delà, on vise par INTENTION (`toutFiltre`), jamais par liste. */
const LIGNES_AFFICHEES = 500;

/** Délai avant qu'un changement de filtre parte en requête. Une frappe ne doit pas faire une requête. */
const DELAI_FILTRES_MS = 350;

/**
 * LA PAGE DE CONTACTS QUE LES FILTRES DÉCRIVENT, rechargée en DEBOUNCE, et la sélection qui suit.
 *
 * 🔴 LE CHARGEMENT RECOCHE, ET C'EST DÉLIBÉRÉ : des filtres qui changent désignent un AUTRE ensemble,
 * donc la sélection d'avant ne veut plus rien dire. Les exclusions partent pour la même raison. Le mode
 * « tout ce qui correspond », lui, RESTE : il suit les filtres, c'est son sens.
 *
 * ⚠️ LES RAPPELS SONT LUS DANS DES REFS, jamais mis en dépendance : `onSelection` est une fermeture
 * recréée à chaque rendu de l'appelant, et la mettre en dépendance relancerait le chargement en boucle,
 * donc une requête par rendu sur un plafond de débit partagé avec toute la console.
 */
export function useContactsFiltres(opts: {
  tenantId: string;
  filtres: ContactFilters;
  /** Faux quand un autre panneau est affiché (import de fichier, HubSpot) : rien à charger. */
  actif: boolean;
  selection: SelectionDestinataires;
  onSelection: (s: SelectionDestinataires) => void;
  /**
   * La sélection d'un brouillon repris, dans une REF que ce chargement CONSOMME (il la remet à `null`).
   * Absente = comportement normal. Elle servait à la reprise d'un brouillon dans l'ancien formulaire.
   */
  restauration?: React.MutableRefObject<RestaurationSelection | null>;
  /** Combien de contacts de la sélection restaurée ont disparu. `null` = rien à signaler. */
  onReduite?: (n: number | null) => void;
}): PageDeContacts {
  const { tenantId, filtres, actif } = opts;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  /**
   * ⚠️ VRAI AU PREMIER RENDU, ET CE N'EST PAS COSMÉTIQUE. Le chargement ne démarre que dans l'effet : à
   * `false`, le tout premier rendu montre un total inconnu SANS chargement en cours, c'est-à-dire
   * exactement la signature d'un comptage en échec. L'écran clignotait « le nombre n'a pas pu être lu »
   * avant d'afficher le bon nombre. Un panneau inactif, lui, repasse à `false` dans le même effet.
   */
  const [enCours, setEnCours] = useState(true);

  // Anti-course : n'appliquer qu'une réponse à jour (une plus récente peut la doubler entre-temps).
  const seqRef = useRef(0);
  const vivantRef = useRef(true);
  // ⚠️ REMIS À VRAI AU MONTAGE, pas seulement mis à faux au démontage : en développement, React monte,
  // démonte puis REMONTE chaque composant. Un drapeau qui ne se relève pas resterait faux pour toujours
  // et le second montage n'afficherait plus jamais un seul contact, sans la moindre erreur.
  useEffect(() => { vivantRef.current = true; return () => { vivantRef.current = false; }; }, []);

  // ⚠️ MIS À JOUR DANS UN EFFET, pas pendant le rendu : écrire dans une ref en plein rendu est ce que
  // React interdit, et l'effet tombe de toute façon bien avant que la minuterie de 350 ms ne lise.
  const rappels = useRef(opts);
  useEffect(() => { rappels.current = opts; });

  useEffect(() => {
    if (!actif) { setEnCours(false); return; }
    setEnCours(true);
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      void (async () => {
        try {
          const [q, c] = await Promise.all([
            queryContacts(tenantId, filtres, { limit: LIGNES_AFFICHEES }),
            countContacts(tenantId, filtres),
          ]);
          if (seq !== seqRef.current || !vivantRef.current) return; // réponse périmée ou écran quitté
          // Normalisé AVANT d'entrer dans l'état. Une réponse 200 sans le champ `contacts` (version d'API
          // en retard, route qui rend `{}`) posait `undefined` dans un état typé tableau : le `.length` du
          // rendu jetait, et React démontait TOUT l'écran. Le `catch` n'y peut rien, il n'y a aucune erreur.
          const liste = Array.isArray(q?.contacts) ? q.contacts : [];
          setContacts(liste);
          // `null` et NON `liste.length` : déduire un total des lignes ramenées inventerait un chiffre
          // plafonné par la limite de la requête, qu'on afficherait comme une vérité.
          setTotal(typeof c?.total === 'number' ? c.total : null);
          const courant = rappels.current;
          const restauree = courant.restauration?.current ?? null;
          if (restauree) {
            // Une seule fois : le prochain changement de filtres reprend le comportement « tout coché ».
            courant.restauration!.current = null;
            // ⚠️ On BORNE la sélection restaurée à ce qui existe encore. Garder un identifiant disparu
            // ferait mentir le compteur, et viser quelqu'un qui ne correspond plus aux filtres.
            const vivants = new Set(liste.filter((x) => restauree.selected.has(x.id)).map((x) => x.id));
            courant.onReduite?.(restauree.selected.size > vivants.size ? restauree.selected.size - vivants.size : null);
            /**
             * 🔴 LES EXCLUSIONS SONT RENDUES TELLES QUELLES, ET SURTOUT PAS ÉLAGUÉES.
             *
             * Une exclusion dont le contact a disparu ne coûte qu'un compteur légèrement bas (elle ne
             * retire plus personne). Élaguer sur les lignes AFFICHÉES coûterait l'inverse : au-delà du
             * plafond d'affichage, la fenêtre change d'une session à l'autre, et une exclusion encore
             * valide en tomberait dehors. Le contact recevrait alors le message dont on l'avait retiré.
             * Les deux erreurs ne se valent pas, on garde donc tout.
             */
            courant.onSelection({ toutFiltre: courant.selection.toutFiltre, selected: vivants, exclus: restauree.exclus });
          } else {
            courant.onReduite?.(null);
            courant.onSelection({
              toutFiltre: courant.selection.toutFiltre,
              selected: new Set(liste.map((x) => x.id)),
              exclus: new Set(),
            });
          }
          setEnCours(false);
        } catch {
          if (seq !== seqRef.current || !vivantRef.current) return;
          setEnCours(false); // erreur silencieuse : on garde l'affichage précédent
        }
      })();
    }, DELAI_FILTRES_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, filtres, actif]);

  return { contacts, total, enCours };
}

/**
 * L'AFFICHAGE : panneau de filtres PARTAGÉ avec le mini-CRM, compteur, et la liste à cocher.
 *
 * ⚠️ `bandeaux` PLUTÔT QUE DES PROPS D'AVERTISSEMENT : les deux écrans posent au-dessus de la liste des
 * messages qui n'appartiennent qu'à eux (récap d'import, sélection reprise qui a maigri). Les décrire
 * ici en ferait une liste à rallonger à chaque nouveau cas d'un seul des deux appelants.
 */
export function ListeDestinataires({
  page, filtres, onFiltres, selection, onSelection, userFields, tagSuggestions, bandeaux,
}: {
  page: PageDeContacts;
  filtres: ContactFilters;
  onFiltres: (f: ContactFilters) => void;
  selection: SelectionDestinataires;
  onSelection: (s: SelectionDestinataires) => void;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  bandeaux?: ReactNode;
}) {
  const t = useT();
  const { contacts, total, enCours } = page;
  const retenus = nbRetenus(selection, total);
  // Un filtre est actif dès qu'une clé est posée -> distingue « aucun résultat » de « aucun contact ».
  const filtresPoses = filtersActive(filtres);

  /** Décocher une ligne l'EXCLUT en mode « tout », la retire de la liste sinon. Jamais les deux. */
  const basculer = (id: string): void => {
    if (selection.toutFiltre) {
      const n = new Set(selection.exclus);
      if (n.has(id)) n.delete(id); else n.add(id);
      onSelection({ ...selection, exclus: n });
      return;
    }
    const n = new Set(selection.selected);
    if (n.has(id)) n.delete(id); else n.add(id);
    onSelection({ ...selection, selected: n });
  };

  return (
    <div className="w-full">
      {bandeaux}
      {/* Recherche/filtres : composant PARTAGÉ avec le mini-CRM (une seule implémentation, pas deux
          moteurs de recherche parallèles qui divergent). */}
      <div className="mb-2">
        <ContactFilterPanel
          filters={filtres}
          onChange={onFiltres}
          userFields={userFields}
          tagSuggestions={tagSuggestions}
          onClear={() => onFiltres({})}
          lignes={contacts}
        />
      </div>

      {/* Compteur live (débounce) + contrôles de sélection sur gros volumes. */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink-900" data-testid="destinataires-total">
          {enCours || total === null ? t('… contacts', '… contacts') : t(`${total} contact(s) correspondent`, `${total} contact(s) match`)}
        </span>
        {total !== null && total > contacts.length && (
          <>
            <span className="text-ink-500">{t(`${contacts.length} affichés sur ${total} au total`, `${contacts.length} shown of ${total} total`)}</span>
            {/* « Tout sélectionner » retient l'INTENTION : aucun identifiant n'est rapatrié. */}
            <button
              type="button"
              onClick={() => onSelection({ toutFiltre: true, selected: new Set(), exclus: new Set() })}
              className="rounded-controle border border-brand-300 bg-brand-50 px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-100"
            >
              {t(`Tout sélectionner (${total})`, `Select all (${total})`)}
            </button>
          </>
        )}
        <Bouton variante="secondaire"
          type="button"
          onClick={() => onSelection({ toutFiltre: false, selected: new Set(), exclus: new Set() })}
        >
          {t('Vider', 'Clear')}
        </Bouton>
      </div>

      {/* Le mode « tout ce qui correspond » doit se VOIR : sans cette ligne, l'écran montre des cases
          cochées et rien ne dit que la campagne en vise beaucoup plus. */}
      {selection.toutFiltre && (
        <div data-testid="campagne-cible-filtre" className="mb-2 rounded-controle border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-800">
          {t(
            `Les ${retenus} contacts qui correspondent aux filtres sont visés, y compris ceux qui ne sont pas affichés ci-dessous. Décocher une ligne l'exclut.`,
            `All ${retenus} contacts matching the filters are targeted, including those not shown below. Unticking a row excludes it.`,
          )}
        </div>
      )}

      {/* Liste des contacts correspondants : cocher/décocher affine la sélection. */}
      <div className="max-h-[22rem] divide-y divide-ink-100 overflow-y-auto rounded-controle border border-ink-200" data-testid="destinataires-liste">
        {contacts.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-ink-50">
            <input type="checkbox" checked={estRetenu(selection, c.id)} onChange={() => basculer(c.id)} className="accent-brand-500" />
            <span className="truncate text-sm">{c.profileName ?? contactIdentity(c)}</span>
            {(c.tags ?? []).slice(0, 3).map((tag) => (
              <span key={tag} className="shrink-0 rounded-controle bg-brand-50 px-1 text-xs text-brand-700">{tag}</span>
            ))}
            <span className="ml-auto shrink-0 font-mono text-xs text-ink-500">{c.phoneE164 ?? <span title={t('Compte WhatsApp (sans numéro)', 'WhatsApp account (no number)')}>{c.bsuid}</span>}</span>
            {c.optInStatus === 'opted_out' && <span className="shrink-0 rounded-controle bg-danger-50 px-1 text-xs text-danger-700">opt-out</span>}
          </label>
        ))}
        {contacts.length === 0 && (
          <p className="px-2.5 py-3 text-xs text-ink-500">
            {enCours ? t('Chargement…', 'Loading…')
              : filtresPoses ? t('Aucun contact ne correspond aux filtres.', 'No contact matches the filters.')
              : t("Aucun contact joignable. Importe des contacts dans l'onglet Contacts.", 'No reachable contact. Import contacts in the Contacts tab.')}
          </p>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-500">{t('Les contacts opt-out sont ignorés automatiquement pour le marketing.', 'Opted-out contacts are automatically skipped for marketing.')}</p>
    </div>
  );
}
