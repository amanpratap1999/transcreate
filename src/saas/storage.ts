import * as crypto from "node:crypto";
import * as path from "node:path";

export class StorageSecurityError extends Error {
  constructor(message = "Storage security violation") {
    super(message);
    this.name = "StorageSecurityError";
  }
}

export interface PutObjectResult {
  storageKey: string;
  sizeBytes: number;
  contentHash: string;
  etag: string;
  createdAt: Date;
}

export interface IObjectStorageService {
  putObject(
    orgId: string,
    relativeKey: string,
    content: string | Buffer,
    contentType?: string
  ): Promise<PutObjectResult>;
  getObject(orgId: string, storageKey: string): Promise<Buffer>;
  deleteObject(orgId: string, storageKey: string): Promise<void>;
  generatePresignedUrl(
    orgId: string,
    storageKey: string,
    operation?: "GET" | "PUT",
    expiresInSeconds?: number
  ): Promise<string>;
  isHealthy(): Promise<boolean>;
}

export class InMemoryObjectStorageService implements IObjectStorageService {
  private bucketName: string;
  private maxFileSize: number;
  private objects = new Map<string, { content: Buffer; contentType: string; createdAt: Date }>();
  private presignedSecret: string;

  constructor(options: { bucketName?: string; maxFileSize?: number; presignedSecret?: string } = {}) {
    this.bucketName = options.bucketName || process.env.S3_BUCKET_NAME || "transcreate-prod-documents";
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB default
    this.presignedSecret = options.presignedSecret || "transcreate_presigned_secret_32_chars_min";
  }

  /**
   * Sanitizes relative key against path traversal, null bytes, and encoded traversal.
   */
  public sanitizeKey(key: string): string {
    if (!key || typeof key !== "string") {
      throw new StorageSecurityError("Storage key must be a non-empty string");
    }

    // Check for null bytes
    if (key.includes("\0")) {
      throw new StorageSecurityError("Storage key contains invalid null byte");
    }

    // Check URL-encoded traversal
    try {
      const decoded = decodeURIComponent(key);
      if (decoded !== key && (decoded.includes("../") || decoded.includes("..\\"))) {
        throw new StorageSecurityError(`URL-encoded traversal detected in storage key: "${key}"`);
      }
    } catch (err: any) {
      if (err instanceof StorageSecurityError) {
        throw err;
      }
      throw new StorageSecurityError(`Invalid URL encoding in storage key: "${key}"`);
    }

    // Check directory traversal
    if (key.includes("../") || key.includes("..\\")) {
      throw new StorageSecurityError(`Path traversal detected in storage key: "${key}"`);
    }

    const posixNormalized = path.posix.normalize(key.replace(/\\/g, "/"));
    if (posixNormalized.startsWith("../") || posixNormalized.includes("/../") || posixNormalized === "..") {
      throw new StorageSecurityError(`Path traversal detected in storage key: "${key}"`);
    }

    return posixNormalized.replace(/^\/+/, "");
  }

  /**
   * Builds an isolated, tenant-scoped storage key: tenants/<orgId>/<sanitizedPath>
   */
  public buildTenantKey(orgId: string, relativeKey: string): string {
    if (!orgId) {
      throw new StorageSecurityError("Missing required orgId in tenant storage boundary");
    }
    const safeRelKey = this.sanitizeKey(relativeKey);
    return `tenants/${orgId}/${safeRelKey}`;
  }

  /**
   * Verifies that an absolute storage key strictly belongs to the given tenant.
   * Prevents cross-tenant object manipulation (Anti-IDOR).
   */
  public assertTenantOwnership(orgId: string, storageKey: string): void {
    const prefix = `tenants/${orgId}/`;
    if (!storageKey.startsWith(prefix)) {
      throw new StorageSecurityError(
        `Tenant "${orgId}" forbidden from accessing object "${storageKey}" outside tenant scope`
      );
    }
  }

  public async putObject(
    orgId: string,
    relativeKey: string,
    content: string | Buffer,
    contentType = "text/markdown; charset=utf-8"
  ): Promise<PutObjectResult> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;

    if (buf.length > this.maxFileSize) {
      throw new StorageSecurityError(
        `File size (${buf.length} bytes) exceeds maximum allowed limit of ${this.maxFileSize} bytes`
      );
    }

    const storageKey = this.buildTenantKey(orgId, relativeKey);
    const contentHash = crypto.createHash("sha256").update(buf).digest("hex");
    const etag = `"${contentHash.slice(0, 32)}"`;

    this.objects.set(storageKey, {
      content: buf,
      contentType,
      createdAt: new Date()
    });

    return {
      storageKey,
      sizeBytes: buf.length,
      contentHash,
      etag,
      createdAt: new Date()
    };
  }

  public async getObject(orgId: string, storageKey: string): Promise<Buffer> {
    this.assertTenantOwnership(orgId, storageKey);
    const obj = this.objects.get(storageKey);
    if (!obj) {
      throw new StorageSecurityError(`Object not found at key: "${storageKey}"`);
    }
    return obj.content;
  }

  public async deleteObject(orgId: string, storageKey: string): Promise<void> {
    this.assertTenantOwnership(orgId, storageKey);
    this.objects.delete(storageKey);
  }

  public async generatePresignedUrl(
    orgId: string,
    storageKey: string,
    operation: "GET" | "PUT" = "GET",
    expiresInSeconds = 900 // 15 mins
  ): Promise<string> {
    this.assertTenantOwnership(orgId, storageKey);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signaturePayload = `${operation}:${this.bucketName}:${storageKey}:${expiresAt}`;
    const signature = crypto
      .createHmac("sha256", this.presignedSecret)
      .update(signaturePayload)
      .digest("hex");

    return `https://${this.bucketName}.s3.amazonaws.com/${storageKey}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=${signature}&X-Amz-Date=${expiresAt}`;
  }

  public async isHealthy(): Promise<boolean> {
    return true;
  }
}

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class S3ObjectStorageService implements IObjectStorageService {
  public sanitizeKey(key: string): string {
    return require('path').posix.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
  }

  public buildTenantKey(orgId: string, relativeKey: string): string {
    const safeKey = this.sanitizeKey(relativeKey);
    return `${orgId}/${safeKey}`;
  }

  public assertTenantOwnership(orgId: string, storageKey: string): void {
    if (!storageKey.startsWith(`${orgId}/`)) {
      throw new StorageSecurityError("Tenant isolation violation");
    }
  }

  private s3: S3Client;
  private bucket: string;

  constructor(options: { bucketName?: string; region?: string; endpoint?: string } = {}) {
    this.bucket = options.bucketName || process.env.S3_BUCKET_NAME || "transcreate-prod-documents";
    this.s3 = new S3Client({
      region: options.region || process.env.AWS_REGION || "us-east-1",
      endpoint: options.endpoint || process.env.AWS_ENDPOINT_URL_S3,
    });
  }

  public async putObject(
    orgId: string,
    relativeKey: string,
    content: string | Buffer,
    contentType = "text/markdown"
  ): Promise<PutObjectResult> {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (buffer.length > (10 * 1024 * 1024)) {
      throw new StorageSecurityError("Payload exceeds 10MB limit");
    }

    const storageKey = this.buildTenantKey(orgId, relativeKey);
    const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType,
      Metadata: { orgId }
    }));

    return {
      storageKey,
      sizeBytes: buffer.length,
      contentHash,
      etag: contentHash, // simplified etag
      createdAt: new Date()
    };
  }

  public async getObject(orgId: string, storageKey: string): Promise<Buffer> {
    this.assertTenantOwnership(orgId, storageKey);
    const result = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    }));
    if (!result.Body) throw new StorageSecurityError(`Object not found at key: "${storageKey}"`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  public async deleteObject(orgId: string, storageKey: string): Promise<void> {
    this.assertTenantOwnership(orgId, storageKey);
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    }));
  }

  public async generatePresignedUrl(
    orgId: string,
    storageKey: string,
    operation: "GET" | "PUT" = "GET",
    expiresInSeconds = 900
  ): Promise<string> {
    this.assertTenantOwnership(orgId, storageKey);
    const command = operation === "GET" 
      ? new GetObjectCommand({ Bucket: this.bucket, Key: storageKey })
      : new PutObjectCommand({ Bucket: this.bucket, Key: storageKey });
    
    return await getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }

  public async isHealthy(): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}


