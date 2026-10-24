// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export class Unauthorized extends Error {}
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type { ProductLink } from "../../server/products.ts";

export interface Application {
  id: string;
  name: string;
  template: "openasy-vpn" | "openasy-infrastructure" | "openasy-vulnerabilities" | "oidc" | "aws" | "saml";
  protocol: "oidc" | "saml";
  saml: { entityId: string; acsUrl: string; nameId: "email" | "persistent" } | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  everyone: boolean;
  groups: string[];
  createdAt: string;
}

/** A new application, or a new secret: the secret is shown once. */
export interface ApplicationSecret {
  application: Application;
  /** null for a SAML application, which trusts Identity's signing certificate. */
  clientSecret: string | null;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  syncedFrom: string | null;
  mfa: "optional" | "required" | "passkey";
  members: number;
  createdAt: string;
}

export interface Person {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer" | "user";
  status: "invited" | "active" | "disabled";
  groups: string[];
  secondFactor: boolean;
  providers: string[];
}

export interface AuditEvent {
  id: number;
  at: string;
  type: string;
  actor?: string;
  actorName: string | null;
  target?: string;
  application?: string;
  applicationName: string | null;
  method?: string;
  ip?: string;
  detail?: string;
}

export interface Overview {
  people: number;
  applications: number;
  groups: number;
  appSignIns24h: number;
  refused24h: number;
  failedSignIns24h: number;
  /** The last 24 hours, one count per hour, oldest first. */
  hourly: { hours: string[]; appSignIns: number[]; refused: number[]; failedSignIns: number[] };
  byApplication: Array<{ id: string; name: string; signIns: number }>;
  withoutSecondFactor: Array<{ id: string; name: string; email: string }>;
}
