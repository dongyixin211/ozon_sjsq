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

export function selectedPostingNumbersInRowOrder(
  rows: Array<{ postingNumber: string }>,
  selectedPostingNumbers: string[],
): string[] {
  const selected = new Set(selectedPostingNumbers);
  const seen = new Set<string>();
  return rows
    .map((row) => row.postingNumber.trim())
    .filter((postingNumber) => {
      if (!postingNumber || !selected.has(postingNumber) || seen.has(postingNumber)) return false;
      seen.add(postingNumber);
      return true;
    });
}
