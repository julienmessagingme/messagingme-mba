'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { EnTetePage } from '@/components/doc-api/elements';
import { DocSignaux } from '@/components/DocSignaux';

/**
 * LES ÉVÉNEMENTS QUE LA CONSOLE REMONTE VERS L'OUTIL DU CLIENT (lot 6) : l'autre sens du branchement. Leur liste
 * est tenue au dictionnaire du serveur par `tests/web-signaux-parite.test.ts`, qui exige que cette page monte
 * la section.
 */
export default function ApiEvenementsPage() {
  return (
    <CadreDoc page="events">
      {() => (
        <>
          <EnTetePage page="events" />
          <DocSignaux />
        </>
      )}
    </CadreDoc>
  );
}
