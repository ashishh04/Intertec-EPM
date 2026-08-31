import { useCallback, useEffect, useState } from 'react';

/**
 * Persisted UI preference. Storage failures (private mode, blocked cookies) are
 * swallowed and the value falls back to in-memory state.
 */
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, [key, value]);

  const update = useCallback((next: T | ((current: T) => T)) => setValue(next), []);

  return [value, update] as const;
}
