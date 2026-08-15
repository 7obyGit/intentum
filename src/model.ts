/** The model capability tier used by the built-in provider selection. */
export const Intelligence = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH"
} as const;

export type Intelligence = typeof Intelligence[keyof typeof Intelligence];

export const DEFAULT_INTELLIGENCE: Intelligence = Intelligence.MEDIUM;

/** Default model names for each Intentum intelligence tier. */
export const INTELLIGENCE_MODELS: Readonly<Record<Intelligence, string>> = {
  LOW: "Luna Low",
  MEDIUM: "Luna High",
  HIGH: "Sol High"
};

export function modelForIntelligence(intelligence: Intelligence): string {
  return INTELLIGENCE_MODELS[intelligence];
}

export function parseIntelligence(value: unknown): Intelligence | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === Intelligence.LOW || value === Intelligence.MEDIUM || value === Intelligence.HIGH) return value;
  throw new TypeError(`Invalid intelligence level: ${String(value)}. Expected LOW, MEDIUM, or HIGH.`);
}

export function resolveIntelligence(value: unknown): Intelligence {
  return parseIntelligence(value) ?? DEFAULT_INTELLIGENCE;
}
