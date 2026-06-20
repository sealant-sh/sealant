import { liveSealantApi } from "./live/client";
import { mockSealantApi } from "./mock/client";

const dataSource = process.env.EXPO_PUBLIC_SEALANT_MOBILE_DATA_SOURCE;

export const sealantApi = dataSource === "live" ? liveSealantApi : mockSealantApi;

export const mobileDataMode = dataSource === "live" ? "live" : "mock";
