'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const s = getSession();
    router.replace(!s ? '/login' : s.role === 'agent' ? '/inbox' : '/dashboard');
  }, [router]);
  return null;
}
