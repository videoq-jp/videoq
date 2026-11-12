import { useEffect, useState } from 'react';

export function useMobileTab<Tab extends string>(defaultTab: Tab) {
  const [mobileTab, setMobileTab] = useState<Tab>(defaultTab);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return { mobileTab, setMobileTab, isMobile };
}
