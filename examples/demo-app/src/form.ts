// reads one text field from a parsed form body; files and repeated fields count as missing
export function formText(form: Record<string, unknown>, name: string): string {
  const value = form[name]
  return typeof value === "string" ? value.trim() : ""
}
