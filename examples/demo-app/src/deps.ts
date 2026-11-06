import type { DemoConfig } from "./config.ts"
import type { SendOtp } from "./mail.ts"
import type { Store } from "./store.ts"

export interface DemoDeps {
  config: DemoConfig
  store: Store
  sendOtp: SendOtp
}
