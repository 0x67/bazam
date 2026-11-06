import { createTransport } from "nodemailer"

export type SendOtp = (to: string, code: string) => Promise<void>

export function smtpOtpSender(smtp: { host: string; port: number }): SendOtp {
  const transport = createTransport({ host: smtp.host, port: smtp.port, secure: false, ignoreTLS: true })
  return async (to, code) => {
    await transport.sendMail({
      from: "Demo app <no-reply@example.test>",
      to,
      subject: "Your sign-in code",
      text: `Your sign-in code is ${code}. It expires in five minutes.`,
    })
  }
}
