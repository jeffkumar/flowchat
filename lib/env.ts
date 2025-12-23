function parseEnvBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export const useGlobalSlack = parseEnvBoolean(process.env.USE_GLOBAL_SLACK);


