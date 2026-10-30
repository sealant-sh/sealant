/**
 * A resource domain never reaches a credential or a harness through a person field. Every field
 * of the control plane API that names a person is a `PersonId` (the walk below), and every
 * credential and harness entry point refuses a domain id in it while the request is decoded: the
 * real `ControlPlaneAPI` is served with a spy for every handler, and a refused request reaches
 * none of them, so nothing was read, decrypted, queued or spent.
 */
import {
  ControlPlaneAPI,
  NOT_A_PERSON,
  PersonId,
  RESOURCE_DOMAIN_ID_PREFIX,
} from "@sealant/api-contracts";
import { Layer, Result, Schema, SchemaAST } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import { afterAll, describe, expect, it } from "vitest";

import { serveControlPlane } from "./control-plane.fixture.js";

const DOMAIN = `${RESOURCE_DOMAIN_ID_PREFIX}6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b`;
const PERSON = "usr_alice";
/**
 * A name that names a person: `userId`, `…UserId`, `principalId`, `personId` or `ownerId`, or a
 * list of them (`userIds`, `…UserIds`). A header is read by its name without `x-sealant-`, in camel
 * case: `x-sealant-principal-id` is `principalId`.
 */
const PERSON_FIELD = /^(userId|[a-z][A-Za-z]*UserId|principalId|personId|ownerId)(s?)$/;
const fieldName = (name: string) =>
  name.replace(/^x-sealant-/, "").replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** The shapes that hold no field. Any shape neither here nor walked below fails the walk. */
const LEAVES = [
  SchemaAST.isString,
  SchemaAST.isNumber,
  SchemaAST.isBoolean,
  SchemaAST.isBigInt,
  SchemaAST.isSymbol,
  SchemaAST.isUniqueSymbol,
  SchemaAST.isLiteral,
  SchemaAST.isEnum,
  SchemaAST.isTemplateLiteral,
  SchemaAST.isNull,
  SchemaAST.isUndefined,
  SchemaAST.isVoid,
  SchemaAST.isNever,
  SchemaAST.isUnknown,
  SchemaAST.isAny,
  SchemaAST.isObjectKeyword,
];

const withoutUndefined = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (!SchemaAST.isUnion(ast)) return ast;
  const defined = ast.types.filter((member) => !SchemaAST.isUndefined(member));
  return defined.length === 1 && defined[0] !== undefined ? defined[0] : ast;
};

const isPersonId = (ast: SchemaAST.AST, list: boolean): boolean => {
  const field = withoutUndefined(ast);
  if (!list) return field === PersonId.ast;
  return (
    SchemaAST.isArrays(field) &&
    field.elements.length === 0 &&
    field.rest.length === 1 &&
    field.rest[0] === PersonId.ast
  );
};

/** Every person field under `ast`, with whether it is a `PersonId`. */
const personFields = (
  ast: SchemaAST.AST,
  path: string,
  seen = new Set<SchemaAST.AST>(),
): Array<{ readonly path: string; readonly ok: boolean }> => {
  if (seen.has(ast)) return [];
  seen.add(ast);
  if (SchemaAST.isObjects(ast)) {
    return [
      ...ast.propertySignatures.flatMap((property) => {
        const at = `${path}.${String(property.name)}`;
        const named =
          typeof property.name === "string" ? PERSON_FIELD.exec(fieldName(property.name)) : null;
        const own =
          named === null ? [] : [{ path: at, ok: isPersonId(property.type, named[2] === "s") }];
        return [...own, ...personFields(property.type, at, seen)];
      }),
      ...ast.indexSignatures.flatMap((index) => personFields(index.type, `${path}[…]`, seen)),
    ];
  }
  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].flatMap((element) =>
      personFields(element, `${path}[]`, seen),
    );
  }
  if (SchemaAST.isUnion(ast)) {
    return ast.types.flatMap((member) => personFields(member, path, seen));
  }
  if (SchemaAST.isSuspend(ast)) return personFields(ast.thunk(), path, seen);
  // A class (`Schema.Class`, a tagged error) holds its fields as its type parameter.
  if (SchemaAST.isDeclaration(ast) && ast.typeParameters.length > 0) {
    return ast.typeParameters.flatMap((parameter) => personFields(parameter, path, seen));
  }
  if (LEAVES.some((isLeaf) => isLeaf(ast))) return [];
  throw new Error(
    `${path}: the person-field walk does not read a ${ast.constructor.name}; teach it to.`,
  );
};

const everyPersonField = Object.values(ControlPlaneAPI.groups).flatMap((group) =>
  Object.entries<HttpApiEndpoint.Top>(group.endpoints).flatMap(([name, endpoint]) => {
    const where = `${group.identifier}.${name}`;
    const parts: ReadonlyArray<readonly [string, Schema.Top | undefined]> = [
      ["params", endpoint.params],
      ["query", endpoint.query],
      ["headers", endpoint.headers],
      ...[...endpoint.payload.values()].flatMap(({ schemas }) =>
        schemas.map((schema) => ["payload", schema] as const),
      ),
      ...[...endpoint.success].map((schema) => ["success", schema] as const),
      ...[...endpoint.error].map((schema) => ["error", schema] as const),
    ];
    return parts.flatMap(([part, schema]) =>
      schema === undefined ? [] : personFields(schema.ast, `${where}.${part}`),
    );
  }),
);

class Member extends Schema.Class<Member>("Member")({ ownerUserId: Schema.String }) {}

describe("person fields", () => {
  it("are all PersonId: an endpoint that names a person any other way fails here", () => {
    expect(everyPersonField.filter(({ ok }) => !ok).map(({ path }) => path)).toEqual([]);
    expect(everyPersonField.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "inference.respond.payload.ownerUserId",
        "workspaces.putWorkspaceCredentials.payload.onBehalfOfUserId",
        "workspaces.listWorkspaceCredentials.success.homes[].onBehalfOfUserId",
        "runs.createRun.payload.ownerUserId",
        "users.getUser.params.userId",
        "workspaces.getWorkspaceSshTarget.headers.x-sealant-principal-id",
        "sshKeys.resolveSshPrincipal.success.principalId",
        "resourceDomains.grantResourceDomainMember.params.userId",
        "resourceDomains.revokeResourceDomainMember.success.userId",
        "resourceDomains.listResourceDomainMembers.success.items[].userId",
        "resourceDomains.getResourceDomainMember.params.userId",
      ]),
    );
  });

  it("are found under every name and in every shape, and the walk refuses a shape it cannot read", () => {
    const named = Schema.Struct({
      memberUserIds: Schema.Array(Schema.String),
      "x-sealant-principal-id": Schema.optional(Schema.String),
      ownerId: Schema.String,
      personId: Schema.String,
      member: Member,
    });
    expect(personFields(named.ast, "named")).toEqual([
      { path: "named.memberUserIds", ok: false },
      { path: "named.x-sealant-principal-id", ok: false },
      { path: "named.ownerId", ok: false },
      { path: "named.personId", ok: false },
      { path: "named.member.ownerUserId", ok: false },
    ]);
    const guarded = Schema.Struct({
      memberUserIds: Schema.Array(PersonId),
      "x-sealant-principal-id": Schema.optional(PersonId),
    });
    expect(personFields(guarded.ast, "guarded").every(({ ok }) => ok)).toBe(true);
    expect(() => personFields(Schema.instanceOf(Date).ast, "opaque")).toThrow(
      "opaque: the person-field walk does not read a Declaration",
    );
  });

  it("refuse a domain id in words that never quote it, and take a person's", () => {
    const decode = Schema.decodeUnknownResult(PersonId);
    expect(Result.isSuccess(decode(PERSON))).toBe(true);
    const refused = decode(DOMAIN);
    expect(Result.isFailure(refused)).toBe(true);
    expect(String(refused)).toContain(NOT_A_PERSON);
    expect(String(refused)).not.toContain(DOMAIN);
  });
});

const reached: string[] = [];
const { handler, dispose } = serveControlPlane({
  provides: Layer.empty,
  reached: (endpoint) => reached.push(endpoint),
});
afterAll(() => dispose());

const send = async (
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, text: await response.text() };
};

interface EntryPoint {
  readonly endpoint: string;
  readonly method: string;
  readonly path: (person: string) => string;
  readonly body: (person: string) => unknown;
  readonly headers?: (person: string) => Record<string, string>;
  /** The field the domain id is put in. */
  readonly field: string;
}

const owner = (body: Record<string, unknown>) => (person: string) => ({
  ownerUserId: person,
  ...body,
});
const at = (path: string) => () => path;

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    endpoint: "createConnectedAccount",
    method: "POST",
    path: at("/v1/connected-accounts"),
    body: owner({ provider: "claude", secret: "sk" }),
    field: "ownerUserId",
  },
  {
    endpoint: "setConnectedAccountDefault",
    method: "PUT",
    path: at("/v1/connected-accounts/defaults/claude"),
    body: owner({ connectedAccountId: "cacc_1" }),
    field: "ownerUserId",
  },
  {
    endpoint: "setProfileCredentialBinding",
    method: "PUT",
    path: at("/v1/profiles/prof_1/credential-bindings"),
    body: owner({ provider: "claude", connectedAccountId: "cacc_1" }),
    field: "ownerUserId",
  },
  {
    endpoint: "putWorkspaceCredentials",
    method: "POST",
    path: at("/v1/workspaces/ws_1/credentials"),
    body: owner({ onBehalfOfUserId: PERSON, home: "/home/alice" }),
    field: "ownerUserId",
  },
  {
    endpoint: "putWorkspaceCredentials",
    method: "POST",
    path: at("/v1/workspaces/ws_1/credentials"),
    body: (person) => ({ ownerUserId: PERSON, onBehalfOfUserId: person, home: "/home/alice" }),
    field: "onBehalfOfUserId",
  },
  {
    endpoint: "applyWorkspaceDotfiles",
    method: "POST",
    path: at("/v1/workspaces/ws_1/dotfiles"),
    body: (person) => ({
      ownerUserId: PERSON,
      onBehalfOfUserId: person,
      user: "alice",
      home: "/home/alice",
    }),
    field: "onBehalfOfUserId",
  },
  {
    endpoint: "createWorkspace",
    method: "POST",
    path: at("/v1/workspaces"),
    body: owner({ registryId: "reg_1", repository: "r", tag: "t", spec: {} }),
    field: "ownerUserId",
  },
  {
    endpoint: "restartWorkspace",
    method: "POST",
    path: at("/v1/workspaces/ws_1/restart"),
    body: owner({}),
    field: "ownerUserId",
  },
  {
    endpoint: "respond",
    method: "POST",
    path: at("/v1/inference/respond"),
    body: owner({ credentials: { claude: "default" }, prompt: "hello" }),
    field: "ownerUserId",
  },
  {
    endpoint: "respond",
    method: "POST",
    path: at("/v1/inference/respond"),
    body: owner({ sessionId: "inf_1", toolResults: [{ toolCallId: "call_1", content: "ok" }] }),
    field: "ownerUserId",
  },
  {
    endpoint: "createRun",
    method: "POST",
    path: at("/v1/runs"),
    body: owner({ workspaceId: "ws_1", harnessId: "claude" }),
    field: "ownerUserId",
  },
  {
    endpoint: "createSession",
    method: "POST",
    path: at("/v1/sessions"),
    body: owner({ workspaceId: "ws_1", argv: ["bash"] }),
    field: "ownerUserId",
  },
  {
    endpoint: "createSessionAsUser",
    method: "POST",
    path: at("/v1/sessions/as-user"),
    body: owner({ workspaceId: "ws_1", argv: ["bash"], user: "alice" }),
    field: "ownerUserId",
  },
  {
    endpoint: "execWorkspace",
    method: "POST",
    path: at("/v1/workspaces/ws_1/exec"),
    body: owner({ commands: [{ executable: "true", args: [] }] }),
    field: "ownerUserId",
  },
  {
    endpoint: "execWorkspaceAsUser",
    method: "POST",
    path: at("/v1/workspaces/ws_1/exec-as-user"),
    body: owner({ commands: [{ executable: "true", args: [] }], user: "alice" }),
    field: "ownerUserId",
  },
  {
    endpoint: "createAccessToken",
    method: "POST",
    path: at("/v1/access-tokens"),
    body: owner({ scopes: ["session:read"] }),
    field: "ownerUserId",
  },
  {
    endpoint: "createSshKey",
    method: "POST",
    path: at("/v1/ssh-keys"),
    body: owner({ publicKey: "ssh-ed25519 AAAA" }),
    field: "ownerUserId",
  },
  {
    endpoint: "bindUserPerson",
    method: "POST",
    path: (person) => `/v1/users/${encodeURIComponent(person)}/person`,
    body: () => ({ id: "alice", uid: 40001, home: "/home/alice" }),
    field: "userId",
  },
  {
    endpoint: "grantResourceDomainMember",
    method: "POST",
    path: (person) =>
      `/v1/resource-domains/rdm:00000000-0000-4000-8000-000000000001/members/${encodeURIComponent(person)}/grant`,
    body: () => ({ version: 1 }),
    field: "userId",
  },
  {
    endpoint: "getWorkspaceSshTarget",
    method: "GET",
    path: at("/v1/workspaces/ws_1/ssh-target"),
    body: () => undefined,
    headers: (person) => ({ "x-sealant-principal-id": person }),
    field: "x-sealant-principal-id",
  },
];

describe("credential and harness entry points", () => {
  it.each(ENTRY_POINTS)(
    "$endpoint refuses a domain in $field before its handler runs",
    async ({ endpoint, method, path, body, headers, field }) => {
      reached.length = 0;
      const refused = await send(method, path(DOMAIN), body(DOMAIN), headers?.(DOMAIN));
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toEqual({
        _tag: "RequestRefusedError",
        message: `${field} ${NOT_A_PERSON}`,
      });
      expect(reached).toEqual([]);

      // The same request for a person reaches the handler: the refusal is the domain id's.
      await send(method, path(PERSON), body(PERSON), headers?.(PERSON));
      expect(reached).toEqual([endpoint]);
    },
  );
});
