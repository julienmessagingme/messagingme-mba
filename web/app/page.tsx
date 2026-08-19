'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, pageDArrivee } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const s = getSession();
    router.replace(!s ? '/login' : pageDArrivee(s.role));
  }, [router]);
  return null;
}
