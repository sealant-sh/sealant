/**
 * The live image API against a stubbed SDK client: what each request carries. Both faults the
 * first live run found (2026-09-20) were in requests no fake of `MicrovmImageApi` could see.
 */
import {
  DeleteMicrovmImageCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
} from "@aws-sdk/client-lambda-microvms";
import { describe, expect, it, vi } from "vitest";

import { createLiveMicrovmImageApi, microvmImageArn } from "./image-api.js";

const BUILD_ROLE = "arn:aws:iam::123456789012:role/sealant-microvm-build";
const NAME = "sealant-ws-0123456789abcdef01234567";
const ARN = `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${NAME}`;

const stubbed = (answer: (command: unknown) => unknown) => {
  const client = new LambdaMicrovmsClient({ region: "eu-central-1" });
  const sent: unknown[] = [];
  vi.spyOn(client, "send").mockImplementation((async (command: unknown) => {
    sent.push(command);
    return answer(command);
  }) as never);
  return {
    sent,
    api: createLiveMicrovmImageApi({ region: "eu-central-1", accountArn: BUILD_ROLE, client }),
  };
};

describe("microvmImageArn", () => {
  it("completes an image name with the partition and account of another ARN", () => {
    expect(microvmImageArn(BUILD_ROLE, "eu-central-1", NAME)).toBe(ARN);
    expect(
      microvmImageArn("arn:aws-us-gov:iam::123456789012:role/build", "us-gov-west-1", NAME),
    ).toBe(`arn:aws-us-gov:lambda:us-gov-west-1:123456789012:microvm-image:${NAME}`);
  });

  it("refuses an ARN that names no account", () => {
    expect(() => microvmImageArn("arn:aws:s3:::a-bucket", "eu-central-1", NAME)).toThrow(
      /names no AWS account/,
    );
  });
});

describe("createLiveMicrovmImageApi", () => {
  it("looks an image up by ARN: the platform refuses a bare name as 'Invalid ARN format'", async () => {
    const { api, sent } = stubbed(() => ({ imageArn: ARN, name: NAME, state: "CREATED" }));

    await expect(api.getImage(NAME)).resolves.toMatchObject({ name: NAME, state: "CREATED" });

    const [command] = sent;
    expect(command).toBeInstanceOf(GetMicrovmImageCommand);
    expect(command).toMatchObject({ input: { imageIdentifier: ARN } });
  });

  it("deletes an image by ARN, and reports one that is already gone", async () => {
    const { api, sent } = stubbed(() => ({}));
    await expect(api.deleteImage(NAME)).resolves.toBe("deleted");
    expect(sent[0]).toBeInstanceOf(DeleteMicrovmImageCommand);
    expect(sent[0]).toMatchObject({ input: { imageIdentifier: ARN } });

    const gone = stubbed(() => {
      throw Object.assign(new Error("gone"), { name: "ResourceNotFoundException" });
    });
    await expect(gone.api.deleteImage(NAME)).resolves.toBe("not-found");
    await expect(gone.api.getImage(NAME)).resolves.toBeUndefined();
  });

  it("lists with the name filter, across pages", async () => {
    const { api, sent } = stubbed((command) =>
      command instanceof ListMicrovmImagesCommand && command.input.nextToken === undefined
        ? { items: [{ imageArn: ARN, name: NAME, state: "CREATED" }], nextToken: "page-2" }
        : { items: [{ imageArn: `${ARN}x`, name: `${NAME}x`, state: "CREATING" }] },
    );

    const images = await api.listImages("sealant-ws");

    expect(images.map((image) => image.name)).toEqual([NAME, `${NAME}x`]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ input: { nameFilter: "sealant-ws" } });
    expect(sent[1]).toMatchObject({ input: { nameFilter: "sealant-ws", nextToken: "page-2" } });
  });
});
