"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The dashboard is a server-rendered view over local files that change from
 * outside the app (Claude writes applications between visits). Re-fetch the
 * server components whenever the tab regains focus or becomes visible again,
 * so the board is never stale when the user switches back to it.
 */
export default function RefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
