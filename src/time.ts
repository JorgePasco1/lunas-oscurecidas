/** Current time formatted in Lima (America/Lima), e.g. "21/08/2026, 14:13:07". */
export function limaNow(): string {
  return new Date().toLocaleString("es-PE", { timeZone: "America/Lima" });
}

/** Today's date in Lima as an ISO YYYY-MM-DD string (lexically comparable). */
export function limaDateYMD(): string {
  // en-CA locale renders as YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Lima" });
}
