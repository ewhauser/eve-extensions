// Derived from vercel/eve PR #208 (Apache-2.0); adapted to load the AWS SDK directly.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StoredJson<T> {
  readonly etag: string;
  readonly value: T;
}

export interface StoredObjectInfo {
  readonly etag?: string;
  readonly size: number;
}

export interface AwsLambdaMicrovmStorage {
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  assertBucketRegion(): Promise<void>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly {
      readonly etag: string;
      readonly partNumber: number;
      readonly sha256: string;
    }[],
    sha256: string,
  ): Promise<{ readonly etag?: string }>;
  createMultipartUpload(key: string): Promise<string>;
  deleteObject(key: string, condition?: { readonly etag?: string }): Promise<void>;
  destroy(): void;
  getJson<T>(key: string): Promise<StoredJson<T> | null>;
  getObjectInfo(key: string): Promise<StoredObjectInfo | null>;
  hasObject(key: string): Promise<boolean>;
  presignGet(key: string, expiresInSeconds?: number): Promise<string>;
  presignUploadParts(
    key: string,
    uploadId: string,
    partSha256s: readonly string[],
    expiresInSeconds?: number,
  ): Promise<readonly string[]>;
  putBytes(
    key: string,
    bytes: Uint8Array,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void>;
  putJson(
    key: string,
    value: unknown,
    condition?: { readonly etag?: string; readonly absent?: boolean },
  ): Promise<{ readonly etag: string }>;
}

export class SdkAwsLambdaMicrovmStorage implements AwsLambdaMicrovmStorage {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #writeEncryption:
    | {
        readonly ServerSideEncryption: "aws:kms";
        readonly SSEKMSKeyId: string;
      }
    | undefined;
  readonly #region: string;

  constructor(
    input: { readonly bucket: string; readonly kmsKeyId?: string; readonly region: string },
    client?: S3Client,
  ) {
    this.#bucket = input.bucket;
    this.#region = input.region;
    this.#client = client ?? new S3Client({ region: input.region });
    this.#writeEncryption =
      input.kmsKeyId === undefined
        ? undefined
        : { ServerSideEncryption: "aws:kms", SSEKMSKeyId: input.kmsKeyId };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.#client.send(
      new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId }),
    );
  }

  async assertBucketRegion(): Promise<void> {
    const output = await this.#client.send(new GetBucketLocationCommand({ Bucket: this.#bucket }));
    const location = normalizeBucketRegion(output.LocationConstraint);
    if (location !== this.#region) {
      throw new Error(
        `AWS Lambda MicroVM artifact bucket "${this.#bucket}" is in ${location}, but the backend region is ${this.#region}.`,
      );
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly {
      readonly etag: string;
      readonly partNumber: number;
      readonly sha256: string;
    }[],
    _sha256: string,
  ): Promise<{ readonly etag?: string }> {
    const output = await this.#client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#bucket,
        ChecksumType: "COMPOSITE",
        Key: key,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ChecksumSHA256: sha256Base64(part.sha256),
            ETag: part.etag,
            PartNumber: part.partNumber,
          })),
        },
        UploadId: uploadId,
      }),
    );
    if (optionalString(output.ChecksumSHA256) === undefined || output.ChecksumType !== "COMPOSITE") {
      throw new Error(`AWS S3 did not verify the composite SHA-256 checksum for ${key}.`);
    }
    return { etag: optionalString(output.ETag) };
  }

  async createMultipartUpload(key: string): Promise<string> {
    const output = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        ChecksumAlgorithm: "SHA256",
        ChecksumType: "COMPOSITE",
        ContentType: "application/zstd",
        Key: key,
        ...this.#writeEncryption,
      }),
    );
    return expectString(output.UploadId, "UploadId");
  }

  async deleteObject(key: string, condition: { readonly etag?: string } = {}): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({
        Bucket: this.#bucket,
        IfMatch: condition.etag,
        Key: key,
      }),
    );
  }

  destroy(): void {
    this.#client.destroy();
  }

  async getJson<T>(key: string): Promise<StoredJson<T> | null> {
    try {
      const output = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      const text = await bodyToString(output.Body);
      return { etag: expectString(output.ETag, "ETag"), value: JSON.parse(text) as T };
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw error;
    }
  }

  async hasObject(key: string): Promise<boolean> {
    return (await this.getObjectInfo(key)) !== null;
  }

  async getObjectInfo(key: string): Promise<StoredObjectInfo | null> {
    try {
      const output = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        etag: optionalString(output.ETag),
        size: expectNonNegativeInteger(output.ContentLength, "ContentLength"),
      };
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw error;
    }
  }

  async presignGet(key: string, expiresInSeconds = 900): Promise<string> {
    return await getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partSha256s: readonly string[],
    expiresInSeconds = 3600,
  ): Promise<readonly string[]> {
    return await Promise.all(
      Array.from(
        partSha256s,
        async (sha256, index) =>
          await getSignedUrl(
            this.#client,
            new UploadPartCommand({
              Bucket: this.#bucket,
              ChecksumAlgorithm: "SHA256",
              ChecksumSHA256: sha256Base64(sha256),
              Key: key,
              PartNumber: index + 1,
              UploadId: uploadId,
            }),
            {
              expiresIn: expiresInSeconds,
              unhoistableHeaders: new Set([
                "x-amz-checksum-sha256",
                "x-amz-sdk-checksum-algorithm",
              ]),
            },
          ),
      ),
    );
  }

  async putBytes(
    key: string,
    bytes: Uint8Array,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: this.#bucket,
        ContentType: "application/zip",
        Key: key,
        Metadata: metadata === undefined ? undefined : { ...metadata },
        ...this.#writeEncryption,
      }),
    );
  }

  async putJson(
    key: string,
    value: unknown,
    condition: { readonly etag?: string; readonly absent?: boolean } = {},
  ): Promise<{ readonly etag: string }> {
    const output = await this.#client.send(
      new PutObjectCommand({
        Body: `${JSON.stringify(value)}\n`,
        Bucket: this.#bucket,
        ContentType: "application/json",
        IfMatch: condition.etag,
        IfNoneMatch: condition.absent === true ? "*" : undefined,
        Key: key,
        ...this.#writeEncryption,
      }),
    );
    return { etag: expectString(output.ETag, "ETag") };
  }
}

async function bodyToString(body: unknown): Promise<string> {
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToString" in body &&
    typeof (body as { readonly transformToString?: unknown }).transformToString === "function"
  ) {
    return await (body as { transformToString(): Promise<string> }).transformToString();
  }
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  throw new Error("AWS S3 returned an unsupported object body.");
}

function normalizeBucketRegion(value: unknown): string {
  if (value === undefined || value === null || value === "") return "us-east-1";
  if (value === "EU") return "eu-west-1";
  return expectString(value, "LocationConstraint");
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AWS S3 response field ${name} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expectNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`AWS S3 response field ${name} is invalid.`);
  }
  return Number(value);
}

function sha256Base64(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("AWS Lambda MicroVM checkpoint SHA-256 is invalid.");
  }
  return Buffer.from(value, "hex").toString("base64");
}

function isS3NotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (["NotFound", "NoSuchKey"].includes(String((error as { readonly name?: unknown }).name)) ||
      (error as { readonly $metadata?: { readonly httpStatusCode?: unknown } }).$metadata
        ?.httpStatusCode === 404)
  );
}
