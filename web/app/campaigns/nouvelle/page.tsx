'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { useRouter } from 'next/navigation';
import {
  getSettings, listTemplates, listWorkflows, listEmailTemplates, listUsers,
  listTags, listUserFields, listPhoneNumbers, listRcsAgents, listRcsMessages,
  listCampaignDrafts,
  type BusinessHours, type CampaignDraft, type TemplateSummary,
} from '@/lib/api';
import { listAgents } from '@/lib/api-agent';
import { isCampaignEligible } from '@/lib/campaign-eligibility';
import {
  AssistantCampagne, REFERENCES_VIDES,
  type CapacitesEspace, type EtapeAssistant, type ReferencesContenu,
} from '@/components/campagne/AssistantCampagne';

/**
 * L'ASSISTANT DE CRÉATION D'UNE CAMPAGNE, sur son propre écran, et le SEUL chemin de création.
 *
 * 🔴 UNE ADRESSE À PART, ET NON UN MODE DE `/campaigns`, ET C'EST CE QUI A SURVÉCU AU RETRAIT DE
 * L'ANCIEN FORMULAIRE (2026-09-13). Une adresse se partage, se recharge, et porte l'étape d'ouverture
 * (`?etape=`) comme le brouillon repris (`?brouillon=`) ; un mode local dans la page de liste ne peut
 * rien de tout cela, et c'est précisément ce que l'écran retiré faisait.
 *
 * ⚠️ CET ÉCRAN CRÉE ET LANCE VRAIMENT DEPUIS LE 2026-09-12. Le bouton du récapitulatif appelle
 * `createCampaign` puis `runCampaign` : ce qui part d'ici part à de vraies personnes.
 */
export default function NouvelleCampagnePage() {
  return <AppShell active="campagnes">{(session) => <AssistantInner session={session} />}</AppShell>;
}

function AssistantInner({ session }: { session: Session }) {
  const router = useRouter();
  const [capacites, setCapacites] = useState<CapacitesEspace | null>(null);
  const [references, setReferences] = useState<ReferencesContenu>(REFERENCES_VIDES);
  /**
   * LE BROUILLON REPRIS, quand l'adresse en nomme un (`?brouillon=<id>`).
   *
   * 🔴 `'chargement'` EST UN TROISIÈME ÉTAT, ET IL EST OBLIGATOIRE. L'assistant lit le brouillon UNE
   * SEULE FOIS, à son initialisation : le monter avant que le brouillon soit arrivé lui donnerait un
   * écran vierge que le chargement suivant ne corrigerait JAMAIS, et l'opérateur retrouverait une page
   * blanche là où il attend son travail. Tant qu'on charge, on ne monte rien.
   *
   * ⚠️ `null` COUVRE LES DEUX CAS OÙ IL N'Y A RIEN À REPRENDRE : aucune adresse de brouillon, ou un
   * identifiant qui ne désigne plus rien (brouillon supprimé entre-temps, lien recopié). Les deux
   * ouvrent une création NEUVE, ce qui est le seul comportement utile.
   */
  const [brouillon, setBrouillon] = useState<CampaignDraft | null | 'chargement'>('chargement');

  /**
   * RELIT LES MODÈLES, ET REND LA LISTE COMPLÈTE.
   *
   * 🔴 LE SÉLECTEUR NE GARDE QUE LES APPROUVÉS, MAIS L'APPELANT A BESOIN DE TOUT. C'est le suivi de la
   * revue Meta qui en dépend (`CreationModeleEnLigne`) : filtrée, la relecture effacerait précisément
   * l'information qu'on vient chercher, si bien que « toujours en revue » et « approuvé » se
   * ressembleraient trait pour trait et que le bouton aurait l'air cassé.
   *
   * ⚠️ `silencieux` est accepté et IGNORÉ ici, et ce n'est pas un oubli : cet écran n'affiche aucune
   * erreur globale (chaque liste tombe pour elle-même, cf. plus bas), il n'a donc rien à taire.
   */
  const rechargerTemplates = useCallback(async (): Promise<TemplateSummary[]> => {
    const r = await listTemplates(session.tenantId);
    const tous = Array.isArray(r?.templates) ? r.templates : [];
    setReferences((ref) => ({ ...ref, templates: tous.filter((t) => t.status === 'APPROVED') }));
    return tous;
  }, [session.tenantId]);

  useEffect(() => {
    let vivant = true;
    const demande = new URLSearchParams(window.location.search).get('brouillon');
    if (!demande) { setBrouillon(null); return () => { vivant = false; }; }
    // ⚠️ Un échec de lecture ouvre une création NEUVE plutôt qu'un écran bloqué : c'est ennuyeux, mais le
    // brouillon reste en base, visible et reprenable depuis la liste des campagnes.
    void listCampaignDrafts(session.tenantId)
      .then((r) => {
        if (!vivant) return;
        const liste = Array.isArray(r?.drafts) ? r.drafts : [];
        setBrouillon(liste.find((d) => d.id === demande) ?? null);
      })
      .catch(() => { if (vivant) setBrouillon(null); });
    return () => { vivant = false; };
  }, [session.tenantId]);

  useEffect(() => {
    let vivant = true;
    /**
     * ⚠️ LECTURE DÉCOUPLÉE ET TOLÉRANTE, comme partout ailleurs sur les réglages. Un hoquet ne doit pas
     * laisser un écran blanc : on retombe sur « pas d'agent RCS, pas d'heures d'ouverture », qui sont les
     * deux réponses PRUDENTES. Elles grisent un canal et affichent un avertissement, elles n'ouvrent
     * jamais quelque chose que l'espace n'a pas.
     */
    void getSettings(session.tenantId)
      .then((s) => {
        if (!vivant) return;
        setCapacites({
          rcsEnabled: s.rcsEnabled === true,
          mbaEnabled: s.mbaEnabled === true,
          // ⚠️ Mêmes deux drapeaux que l'ancien formulaire : le connecteur branché décide si la source
          // HubSpot est AFFICHÉE, la pause décide si elle est cliquable. Les confondre montrerait un
          // panneau vide à un espace qui n'a pas HubSpot, ou masquerait une pause qui se lève d'un clic.
          hubspotListes: s.hubspotListsEnabled === true,
          hubspotEnPause: s.campaignsPaused === true,
          ...(s.businessHours ? { businessHours: s.businessHours as BusinessHours } : {}),
        });
      })
      .catch(() => { if (vivant) setCapacites({ rcsEnabled: false, mbaEnabled: false, hubspotListes: false, hubspotEnPause: false }); });
    return () => { vivant = false; };
  }, [session.tenantId]);

  useEffect(() => {
    let vivant = true;
    /**
     * 🔴 CHACUNE POUR ELLE-MÊME, JAMAIS UN `Promise.all` TOUT-OU-RIEN. Cinq listes alimentent l'étape
     * Contenu ; si l'une tombe, les quatre autres doivent rester choisissables. Un `all` aurait fait
     * d'une panne de la liste des agents IA un écran de campagne entièrement vide.
     *
     * ⚠️ `Array.isArray` EN PLUS DU `catch`, et ce n'est pas de la ceinture-bretelles : une réponse 200
     * sans la clé attendue (backend plus ancien, proxy qui rend un objet vide) passe le `catch` et pose
     * `undefined` dans un état typé tableau. Le rendu suivant lit `.length` dessus et c'est TOUT l'écran
     * qui casse, pas seulement la liste concernée.
     */
    const poser = (patch: Partial<ReferencesContenu>): void => { if (vivant) setReferences((r) => ({ ...r, ...patch })); };
    void listTemplates(session.tenantId)
      .then((r) => poser({ templates: (Array.isArray(r?.templates) ? r.templates : []).filter((t) => t.status === 'APPROVED') }))
      .catch(() => {});
    void listWorkflows(session.tenantId)
      // Le sélecteur ne propose QUE les scénarios lançables en campagne (ceux qui OUVRENT par un template
      // configuré), même règle que l'ancien formulaire. L'éligibilité vient du SERVEUR quand il la donne.
      .then((r) => poser({
        workflows: (Array.isArray(r?.workflows) ? r.workflows : [])
          .filter((w) => w.campaignEligible ?? (w.graph ? isCampaignEligible(w.graph) : false)),
      }))
      .catch(() => {});
    void listEmailTemplates(session.tenantId)
      .then((r) => poser({ emailTemplates: (Array.isArray(r?.templates) ? r.templates : []).map((t) => ({ id: t.id, name: t.name })) }))
      .catch(() => {});
    void listUsers(session.tenantId)
      /**
       * 🔴 LES INVITATIONS EN ATTENTE RESTENT DANS LA LISTE, GRISÉES (2026-09-12). Ce filtre les RETIRAIT,
       * et Julien a ouvert l'écran pour y voir UNE personne sur les trois de son espace, sans un mot. Le
       * motif écrit ici était juste (assigner à quelqu'un qui ne peut pas se connecter range les
       * conversations là où personne ne les lira) ; c'est le SILENCE qui ne l'était pas. Le produit grise
       * un canal non configuré AVEC SA RAISON plutôt que de le masquer, et ici l'empêchement est en plus
       * levable par celui qui le voit : il suffit que la personne accepte son invitation.
       *
       * ⚠️ LE COMPTE RÉVOQUÉ, LUI, RESTE ÉCARTÉ : son empêchement n'est pas levable par le lecteur, et
       * l'afficher allongerait la liste de comptes qui ne reviendront pas.
       */
      .then((r) => poser({
        membres: (Array.isArray(r?.users) ? r.users : [])
          .filter((u) => !u.disabled)
          .map((u) => ({ id: u.id, nom: u.name ?? u.email, enAttente: u.pending === true })),
      }))
      .catch(() => {});
    void listAgents(session.tenantId)
      .then((a) => poser({ agents: (Array.isArray(a) ? a : []).map((x) => ({ id: x.id, label: x.label })) }))
      .catch(() => {});
    // Les quatre listes des étapes Audience et Récapitulatif, chargées de la même façon et pour la même
    // raison : un hoquet sur les tags ne doit pas priver l'écran de son numéro d'expédition.
    void listTags(session.tenantId)
      .then((r) => poser({ tags: Array.isArray(r?.tags) ? r.tags : [] }))
      .catch(() => {});
    void listUserFields(session.tenantId)
      .then((r) => poser({ userFields: Array.isArray(r?.fields) ? r.fields : [] }))
      .catch(() => {});
    void listPhoneNumbers(session.tenantId)
      .then((r) => poser({ numeros: Array.isArray(r?.phoneNumbers) ? r.phoneNumbers : [] }))
      .catch(() => {});
    void listRcsAgents(session.tenantId)
      .then((r) => poser({ agentsRcs: Array.isArray(r?.agents) ? r.agents : [] }))
      .catch(() => {});
    // ⚠️ La BIBLIOTHÈQUE de messages RCS, pour partir d'un message déjà écrit. Chargée comme les autres et
    // pour la même raison : un hoquet ici ne doit priver l'écran de rien d'autre que du sélecteur « partir
    // d'un message enregistré », dont le cas vide le dit déjà.
    void listRcsMessages(session.tenantId)
      .then((r) => poser({ messagesRcs: Array.isArray(r?.messages) ? r.messages : [] }))
      .catch(() => {});
    return () => { vivant = false; };
  }, [session.tenantId]);

  if (!capacites || brouillon === 'chargement') return <p className="text-sm text-ink-400">Chargement...</p>;

  /**
   * ⚠️ L'ÉTAPE D'OUVERTURE SE LIT DANS L'ADRESSE (`?etape=canal`), et cela ne sert pas qu'aux tests : un
   * assistant à cinq écrans dont on ne peut pas partager une étape oblige à tout refaire pour montrer un
   * détail à quelqu'un. La valeur est validée contre la liste, jamais transtypée : une adresse est une
   * entrée non fiable comme une autre.
   */
  const demandee = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('etape');
  const connues: EtapeAssistant[] = ['nom', 'canal', 'contenu', 'audience', 'recap'];
  const etapeInitiale = connues.find((e) => e === demandee) ?? 'nom';

  /**
   * ⚠️ L'ÉTAT D'OUVERTURE SE LIT AUSSI DANS L'ADRESSE, et UNIQUEMENT pour le canal (`?canal=repli`).
   * L'étape Contenu ne montre une chaîne que si une chaîne a été choisie : sans ce paramètre, l'ouvrir
   * directement n'afficherait qu'un seul étage, et il faudrait repasser par l'étape 2 à chaque fois pour
   * regarder l'écran suivant. Comme au-dessus, la valeur est validée contre la liste.
   */
  const canalDemande = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('canal');
  const formules = ['whatsapp', 'rcs', 'repli'] as const;
  const formule = formules.find((f) => f === canalDemande);
  const troisiemeDemande = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('troisieme');
  const troisiemes = ['aucun', 'email'] as const;
  const troisieme = troisiemes.find((t) => t === troisiemeDemande);

  return (
    <AssistantCampagne
      tenantId={session.tenantId}
      capacites={capacites}
      references={references}
      rechargerTemplates={rechargerTemplates}
      etapeInitiale={etapeInitiale}
      etatInitial={{ ...(formule ? { formule } : {}), ...(troisieme ? { troisieme } : {}) }}
      {...(brouillon ? { brouillon } : {})}
      // ⚠️ La redirection se fait APRÈS que l'écran a dit « lancée » : partir tout de suite priverait
      // l'opérateur du seul accusé de réception qu'il aura, et il relancerait.
      onCree={() => { setTimeout(() => router.push('/campaigns'), 1200); }}
    />
  );
}
