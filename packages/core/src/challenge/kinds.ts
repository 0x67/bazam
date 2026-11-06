export interface ChallengeKindSpec {
  /** otp-email, otp-sms, totp, passkey, pin, or a plugin kind. */
  name: string;
  /** value: the answer is filled into a field; action: the person or resolver acts in the app. */
  answer: "value" | "action";
  humanOnly: boolean;
  /** Whether a person may take over after an automated resolver failed once the trigger ran. */
  fallbackAfterTrigger: boolean;
}

export const builtinKinds: readonly ChallengeKindSpec[] = [
  { name: "otp-email", answer: "value", humanOnly: false, fallbackAfterTrigger: true },
  { name: "otp-sms", answer: "value", humanOnly: false, fallbackAfterTrigger: true },
  { name: "totp", answer: "value", humanOnly: false, fallbackAfterTrigger: true },
  { name: "passkey", answer: "action", humanOnly: false, fallbackAfterTrigger: false },
  // no automated resolver may serve pin, so there is nothing to fall back from
  { name: "pin", answer: "action", humanOnly: true, fallbackAfterTrigger: false },
];

/** A human-only kind never takes a value, whatever its `answer` says. */
export function takesValue(kind: ChallengeKindSpec): boolean {
  return kind.answer === "value" && !kind.humanOnly;
}
