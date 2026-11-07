import parsePhoneNumber from "libphonenumber-js";

export type PhoneForm =
  | "e164"
  | "countryCode"
  | "callingCode"
  | "region"
  | "countryName"
  | "flag"
  | "national"
  | "domestic";

const PHONE_FORMS: ReadonlySet<string> = new Set<PhoneForm>([
  "e164",
  "countryCode",
  "callingCode",
  "region",
  "countryName",
  "flag",
  "national",
  "domestic",
]);

export function isPhoneForm(name: string): name is PhoneForm {
  return PHONE_FORMS.has(name);
}

/**
 * `form` of the phone number in `e164`, or undefined when it is not a possible number, has an extension or has no such form.
 * Possible rather than valid, so fictional ranges such as +44 7700 900xxx work.
 * `locale` is a BCP 47 tag that sets the language of `countryName`.
 */
export function phoneForm(e164: string, form: PhoneForm, locale: string): string | undefined {
  // without extract, text around a number does not count as a number
  const phone = parsePhoneNumber(e164, { extract: false });
  // no form carries an extension, and domestic would glue its digits onto the number
  if (phone === undefined || !phone.isPossible() || phone.ext !== undefined) return undefined;
  // a fictional range belongs to no one country, so take the first that shares its calling code
  const region = phone.country ?? phone.getPossibleCountries()[0];
  switch (form) {
    case "e164":
      return phone.number;
    case "countryCode":
      return `+${phone.countryCallingCode}`;
    case "callingCode":
      return phone.countryCallingCode;
    case "region":
      return region;
    case "countryName":
      return region === undefined ? undefined : new Intl.DisplayNames([locale], { type: "region" }).of(region);
    case "flag":
      return region === undefined ? undefined : flagOf(region);
    case "national":
      return phone.nationalNumber;
    case "domestic":
      return phone.formatNational().replace(/\D/g, "");
  }
}

/** The pair of regional indicator symbols for a two letter region code. */
function flagOf(region: string): string {
  const REGIONAL_INDICATOR_A = 0x1f1e6;
  return String.fromCodePoint(
    ...region.split("").map((letter) => REGIONAL_INDICATOR_A + letter.charCodeAt(0) - "A".charCodeAt(0)),
  );
}
