export function parseOrderNumbers(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[,\uFF0C;\uFF1B\s]+/u)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}
