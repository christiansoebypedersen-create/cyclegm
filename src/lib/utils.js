// Minimal classname joiner — the vendored lucide-animated icon components import
// `cn` from "@/lib/utils". They only ever call cn(className), so a tiny join is
// all that's needed (no clsx/tailwind-merge dependency).
export function cn(...inputs) {
  return inputs.filter(Boolean).join(" ");
}
