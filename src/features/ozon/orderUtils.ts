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

export function hasBaiduBdussCookie(value: string): boolean {
  return value.split(";").some((part) => {
    const [key, ...rest] = part.trim().split("=");
    return key.trim() === "BDUSS" && rest.join("=").trim().length > 0;
  });
}
