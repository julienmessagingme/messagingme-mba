'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getSession() ? '/contacts' : '/login');
  }, [router]);
  return null;
}
