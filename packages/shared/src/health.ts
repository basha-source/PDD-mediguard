/**
 * Health-profile sentinels.
 *
 * The health forms let a patient say "nothing to declare" by picking a chip —
 * "Normal" for conditions, "None" for allergies — and that literal string is
 * stored in the user document next to any real entries. So anything that reads
 * the list as clinical data (an allergy alert, an interaction or safety check,
 * a filter, an AI prompt) has to drop the sentinels first, or it ends up
 * warning about an allergen called "None".
 */
export const HEALTH_SENTINELS: readonly string[] = ["none", "normal"];

/** The real conditions/allergies only — sentinels and blanks removed. */
export function withoutHealthSentinels(values?: string[]): string[] {
  return (values ?? []).filter((v) => {
    const t = v.trim().toLowerCase();
    return t !== "" && !HEALTH_SENTINELS.includes(t);
  });
}
