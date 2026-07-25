"use client";

import { useEffect } from "react";
import { ENCODER_URL, GALLERY_BIN, GALLERY_JSON, POKEDEX_JSON } from "@/lib/pokematch/assets";

/**
 * Warms the browser cache for PokéMatch's biggest assets (the ~44MB encoder +
 * gallery) as soon as the site opens, during idle time, so the model is mostly
 * downloaded by the time the user enters PokéMatch and scans. Only fetches the
 * bytes — it does NOT import onnxruntime, so the home bundle stays light; the
 * session is compiled later on the PokéMatch page from these cached bytes.
 */
export function PokematchPrefetch() {
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      for (const url of [ENCODER_URL, GALLERY_BIN, GALLERY_JSON, POKEDEX_JSON]) {
        fetch(url, { cache: "force-cache" }).catch(() => {});
      }
    };
    const hasRIC = typeof requestIdleCallback === "function";
    const id = hasRIC ? requestIdleCallback(warm, { timeout: 3000 }) : window.setTimeout(warm, 1500);
    return () => {
      cancelled = true;
      if (hasRIC) cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, []);
  return null;
}
