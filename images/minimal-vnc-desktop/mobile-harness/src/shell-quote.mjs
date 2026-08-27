export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
