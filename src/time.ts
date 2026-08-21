/** Current time formatted in Lima (America/Lima), e.g. "21/08/2026, 14:13:07". */
export function limaNow(): string {
  return new Date().toLocaleString("es-PE", { timeZone: "America/Lima" });
}
