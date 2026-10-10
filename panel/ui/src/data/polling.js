// Reading of a new-model screen: fn() now and every 20 s while the screen is open (and again when deps change);
// keeps the last good answer when a read fails. reload() reads again at once (e.g. after recalculating the usage).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { REFRESH_MS } from './api.js';

export function usePolling(fn, deps) {
  const [read, setRead] = useState({ answer: null, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const answer = await fn();
      if (mine === seq.current) setRead({ answer, error: null });
    } catch (error) {
      if (mine === seq.current) setRead((r) => ({ answer: r.answer, error }));
    }
  }, deps);
  useEffect(() => {
    setRead({ answer: null, error: null });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { ...read, reload: load };
}
