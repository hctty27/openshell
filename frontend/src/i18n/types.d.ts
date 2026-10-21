import "i18next";
import type { resources } from ".";
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof resources.en;
  }
}
