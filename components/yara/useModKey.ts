"use client";

import { useEffect, useState } from "react";

/** "⌘" on Apple platforms, "Ctrl" elsewhere. Resolved after mount to keep hydration stable. */
export function useModKey() {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  return mod;
}
