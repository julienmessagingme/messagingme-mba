'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { getSettings, type BusinessHours } from '@/lib/api';
import { AssistantCampagne, type CapacitesEspace, type EtapeAssistant } from '@/components/campagne/AssistantCampagne';

/**
 * L'ASSISTANT DE CRÉATION D'UNE CAMPAGNE, sur son propre écran.
 *
 * 🔴 UNE ADRESSE À PART, ET NON UN MODE DE `/campaigns`, TANT QUE L'ANCIEN FORMULAIRE EST EN SERVICE.
 * `CampaignCreateForm` reste le chemin de création réel : le remplacer ici couperait la seule façon de
 * lancer une campagne avant que l'audience et le récapitulatif existent. Une adresse séparée permet de
 * livrer les étapes une par une, de les montrer, et de basculer le bouton « Nouvelle campagne » le jour
 * où le parcours est complet.
 *
 * ⚠️ CET ÉCRAN NE CRÉE ENCORE RIEN. Il n'y a aucun bouton de lancement, et c'est délibéré : un parcours
 * qui envoie sans avoir demandé le contenu ni l'audience enverrait une campagne vide à personne.
 */
export default function NouvelleCampagnePage() {
  return <AppShell active="campagnes">{(session) => <AssistantInner session={session} />}</AppShell>;
}

function AssistantInner({ session }: { session: Session }) {
  const [capacites, setCapacites] = useState<CapacitesEspace | null>(null);

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
        setCapacites({ rcsEnabled: s.rcsEnabled === true, ...(s.businessHours ? { businessHours: s.businessHours as BusinessHours } : {}) });
      })
      .catch(() => { if (vivant) setCapacites({ rcsEnabled: false }); });
    return () => { vivant = false; };
  }, [session.tenantId]);

  if (!capacites) return <p className="text-sm text-ink-400">Chargement...</p>;

  /**
   * ⚠️ L'ÉTAPE D'OUVERTURE SE LIT DANS L'ADRESSE (`?etape=canal`), et cela ne sert pas qu'aux tests : un
   * assistant à cinq écrans dont on ne peut pas partager une étape oblige à tout refaire pour montrer un
   * détail à quelqu'un. La valeur est validée contre la liste, jamais transtypée : une adresse est une
   * entrée non fiable comme une autre.
   */
  const demandee = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('etape');
  const connues: EtapeAssistant[] = ['nom', 'canal', 'contenu', 'audience', 'recap'];
  const etapeInitiale = connues.find((e) => e === demandee) ?? 'nom';

  return <AssistantCampagne capacites={capacites} etapeInitiale={etapeInitiale} />;
}
