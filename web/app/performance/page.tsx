'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { CarteCouts } from '@/components/CarteCouts';
import { NuageQualitatifCard } from '@/components/NuageQualitatifCard';
import { CarteIntentions } from '@/components/CarteIntentions';
import type { Session } from '@/lib/session';
import type { StatsRange } from '@/lib/api';
import { presetRange } from '@/lib/range';
import { useT } from '@/lib/i18n';
import { ErreursRegroupees } from '@/components/Nd';

/**
 * La page de synthèse du Performance Lab.
 *
 * Elle répond à DEUX questions, et c'est tout ce qu'elle fait : où en sont les conversations (urgence et
 * satisfaction, lot F), et ce que coûte un engagement (lot E). Le détail Analytics reste dans les
 * sous-onglets : cette page n'en est pas un résumé, elle porte ce que les autres écrans ne montrent nulle
 * part.
 *
 * ⚠️ ADRESSE NEUVE, `/performance`, et c'est la SEULE de toute la refonte des menus. Le lot A avait
 * explicitement refusé de la créer tant qu'elle n'aurait rien à montrer : une page d'aiguillage vide aurait
 * ajouté un clic à tout le monde. Elle arrive avec son premier contenu, pas avant.
 */
export default function PerformanceSynthesePage() {
  return <AppShell active="perf-synthese">{(session) => <SyntheseInner session={session} />}</AppShell>;
}

function SyntheseInner({ session }: { session: Session }) {
  // Même période par défaut que les écrans Analytics : passer de l'un à l'autre ne doit pas changer la
  // fenêtre sous les pieds de l'utilisateur.
  const t = useT();
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));

  return (
    <div className="space-y-4">
      {/* Sans titre : l'onglet actif dit déjà « Performance Lab », et « Synthèse » juste en dessous
          n'apprenait rien tout en poussant les deux cartes d'une ligne vers le bas. */}
      <RangeBar range={range} onChange={setRange} />
      {/*
        🔴 DEUX COLONNES, ET L'ORDRE COMPTE DANS LES DEUX SENS DE LECTURE. Le coût est à GAUCHE parce que
        c'est la question qu'on se pose en arrivant (« combien ça me coûte »), et parce qu'il se lit dès le
        premier jour ; le nuage est à droite et se remplit avec le temps. Empilées, ces deux cartes
        obligeaient à faire défiler pour comparer une dépense à un ressenti, ce qui est exactement la
        comparaison que cette page existe pour permettre.

        ⚠️ `items-start` : sans lui, la grille étire les deux cartes à la hauteur de la plus haute, et la
        plus courte se retrouve avec un grand vide blanc sous son contenu. En dessous de `lg`, on retombe
        sur une colonne unique, dans le même ordre.
      */}
      {/* UNE SEULE ERREUR POUR L'ÉCRAN : une panne du serveur faisait répéter la même phrase rouge par les trois
          cartes, ligne par ligne. Les cartes gardent leur « n/d » à l'endroit du chiffre manquant. */}
      <ErreursRegroupees message={t('Certains chiffres n’ont pas pu être lus. Réessayez dans un instant.', 'Some figures could not be read. Try again in a moment.')}>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <CarteCouts tenantId={session.tenantId} range={range} />
        {/* ⚠️ LA COLONNE DE DROITE PORTE DEUX CARTES DEPUIS LE 2026-09-17, et l'ordre est celui que Julien
            a décrit : les intentions D'ABORD, la matrice en dessous. Les intentions se lisent dès la
            première conversation analysée ; la matrice, elle, a besoin de volume pour dire quelque chose. */}
        <div className="space-y-4">
          <CarteIntentions tenantId={session.tenantId} range={range} />
          <NuageQualitatifCard tenantId={session.tenantId} range={range} />
        </div>
      </div>
      </ErreursRegroupees>
    </div>
  );
}
