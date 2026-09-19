import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { LiveEvent } from "@/convex/firebaseRtdb";

export interface LiveActivityState {
  loading: boolean;
  error: boolean;
  configured: boolean;
  reason: string | null;
  events: LiveEvent[];
}

const INITIAL: LiveActivityState = {
  loading: true,
  error: false,
  configured: true,
  reason: null,
  events: [],
};

const REFRESH_MS = 10_000;

/**
 * Polls the Firebase RTDB live feed (via the readLiveFeed action). RTDB also
 * pushes to connected clients in real time; polling keeps this simple and
 * works everywhere. Only polls while `enabled` and the tab is visible.
 */
export function useLiveActivity(enabled: boolean, refreshMs = REFRESH_MS): LiveActivityState {
  const readLiveFeed = useAction(api.firebaseRtdb.readLiveFeed);
  const [state, setState] = useState<LiveActivityState>(INITIAL);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const feed = await readLiveFeed({ limit: 25 });
      if (!mounted.current) return;
      setState({
        loading: false,
        error: false,
        configured: feed.configured,
        reason: feed.reason,
        events: feed.events,
      });
    } catch {
      if (mounted.current) setState((s) => ({ ...s, loading: false, error: true }));
    }
  }, [readLiveFeed]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, refreshMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [enabled, refresh, refreshMs]);

  return state;
}
